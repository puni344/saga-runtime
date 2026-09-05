# Saga Runtime — Architecture

This document is derived from the code, not from intent: every claim below is cited to the file and line that implements it (checked against the current working tree). Figures in the AI-evaluation section were recomputed directly from the cached payloads in `src/ai/cache/` rather than copied from `README.md`. Sections that document behavior are cross-linked to the matching `README.md` section at the end of each block.

The headline contract, restated in one sentence: *AI interprets. Policy authorizes with evidence gates. Saga moves money exactly once. Store persists it atomically. Rail and verifier attest truth.* ([README § AI Risk Analysis](README.md#ai-risk-analysis))

## 1. Runtime data flow

The HTTP boundary is `src/server.js`. Every financial entry point funnels into the saga engine under a per-key lock, and every transition ends in one transactional write to a single SQLite file.

| Step | Code path |
|---|---|
| Request enters | `POST /api/begin` → `store.withLock('__begin_' + idempotencyKey, store.begin(...))` ([server.js:59-63](src/server.js#L59-L63)); `POST /api/analyze` → `riskAnalyzer.analyze()` then `validateAndEvaluatePolicy()` ([server.js:108-120](src/server.js#L108-L120)) |
| Interpretation + policy + begin in one call | `POST /api/analyze-and-begin` ([server.js:121-154](src/server.js#L121-L154)): analyze → policy → if `BLOCK`, return `saga: null` ([server.js:133](src/server.js#L133)); otherwise build a review record when `decision.reviewRequired` ([server.js:134-137](src/server.js#L134-L137)), attach `structuredIntent` / `structuredChecks` / `paymentFacts` / `verificationRequirements` as saga context ([server.js:138-143](src/server.js#L138-L143)), `store.begin(idempotencyKey, numAmount, scenario, {riskFlag, review, context})` ([server.js:144](src/server.js#L144)) |
| Gated request never drives money | on `decision === 'REVIEW'` the saga is returned **without calling `attempt()`** — no payment is created ([server.js:147-151](src/server.js#L147-L151)); the gate is enforced again inside `SagaEngine.attempt()` ([saga.js:288-295](src/saga.js#L288-L295)): while `review.status === 'PENDING'` it logs `REVIEW_PENDING_BLOCKS_MONEY` and returns without debiting or calling the rail ([saga.js:293-294](src/saga.js#L293-L294)) |
| Gate resolution | `POST /api/review {sagaId, decision: approve|deny}` → `engine.resolveReview(action)` ([server.js:159-166](src/server.js#L159-L166)); only `resolveReview` can open the gate ([saga.js:231-250](src/saga.js#L231-L250)) — `approve` flips status to `APPROVED`, `deny` transitions to `FAILED` with `review denied before money moved` ([saga.js:238-245](src/saga.js#L238-L245)) |
| Normal money flow | `POST /api/attempt` ([server.js:64-70](src/server.js#L64-L70)) → `attempt()`: create payment → submit → settle → exactly one `commitLedger` debit ([saga.js:288-339](src/saga.js#L288-L339)); `EXTERNAL_UNKNOWN` → `reconcile()` ([saga.js:329-333](src/saga.js#L329-L333), [saga.js:334-338](src/saga.js#L334-L338)) |
| Other operators | `POST /api/retry` (blocked while `EXTERNAL_UNKNOWN`) ([server.js:79-85](src/server.js#L79-L85)); `POST /api/reconcile` ([server.js:71-78](src/server.js#L71-L78)); `POST /api/compensate` → `engine.compensate(reason)` ([server.js:86-93](src/server.js#L86-L93), [saga.js:252-286](src/saga.js#L252-L286)) — idempotent refund with a one-refund guard ([saga.js:254](src/saga.js#L254), [saga.js:280-281](src/saga.js#L280-L281)) |
| External truth (poll side) | `getPaymentStatus()`/`refundPayment()` on the rail; success/fail/unknown become the external truth the saga reconciles against ([rail.js:48-69](src/rail.js#L48-L69)) |
| External truth (push side) | `POST /webhooks/payment` — HMAC-SHA256 over the exact raw body via `verifyWebhookSignature` ([server.js:173-196](src/server.js#L173-L196)); no secret → 503 ([server.js:179](src/server.js#L179)), bad signature → 401 ([server.js:180-182](src/server.js#L180-L182)), unknown payment recorded but never applied ([server.js:187-192](src/server.js#L187-L192)), known payment → `engine.applyEvent(...)` which reconciles the saga ([server.js:193-195](src/server.js#L193-L195), [saga.js:220-229](src/saga.js#L220-L229)) |
| Persistence | every mutation re-enters via `store.save(engine)` → one `BEGIN IMMEDIATE` transaction over saga snapshot + rail payment row (+ event row) ([store.js:255-326](src/store.js#L255-L326)) |

Analytic endpoints are read noise, not money: `GET /api/sagas`, `GET /api/reviews` (only `PENDING` gates), `POST /api/evaluate` (runs the configured analyzer over a dataset), plus the static dashboard, all served by the same handler ([server.js:105-107](src/server.js#L105-L107), [server.js:155-158](src/server.js#L155-L158), [server.js:167-172](src/server.js#L167-L172), [server.js:200-204](src/server.js#L200-L204)).

The on-disk browser flow matches this exactly: "Continue Saga" (`#attempt`) first `POST /api/review {decision:'approve'}`, then `POST /api/attempt` ([static/app.js:89-94](static/app.js#L89-L94)); analysis preview goes straight to `/api/analyze-and-begin` ([static/app.js:58-77](static/app.js#L58-L77)).

> README: [## Architecture](README.md#architecture), [### Agentic-payment design mapping](README.md#agentic-payment-design-mapping-how-this-maps-onto-a-real-agentic-payment-system)

## 2. Authority boundary

Who may decide what is enforced in `src/ai/policy.js`, `src/ai/schema.js`, and `src/saga.js`.

- **Hard rules always override AI.** `HARD_RULES` = `AMOUNT_POSITIVE`, `AMOUNT_REASONABLE` (caps at 10,00,000 = ≤1,000,000), `INSTRUCTION_EXISTS` ([policy.js:3-30](src/ai/policy.js#L3-L30)). Any violation returns `decision: 'BLOCK'` with `HARD_RULE_VIOLATION` ([policy.js:101-113](src/ai/policy.js#L101-L113)) — an AI claim of LOW_RISK cannot suppress it.
- **The request amount is the only authoritative money figure.** `buildPaymentFacts` takes `requestedAmount: Number(request.amount)` straight from the request; AI contributes only the `structured_intent` fields ([policy.js:35-50](src/ai/policy.js#L35-L50)). `structuredChecks.expectedAmountConsistent` only *reports* whether the AI agreed — it never adopts an AI amount ([policy.js:81-88](src/ai/policy.js#L81-L88)).
- **Gates are a pure function of extracted facts.** `deriveVerificationRequirements` maps facts to gates with no AI involvement: `override_language` → `OVERRIDE_CLAIM_VERIFICATION`; `authority_claim` → `AUTHORITY_VERIFICATION:<claim>`; `HIGH_RISK` / `requires_confirmation` → `RISK_ADJUDICATION`; `AMBIGUOUS` → `AMBIGUITY_RESOLUTION`; confidence < 0.5 → `LOW_CONFIDENCE_REVIEW`; confidence < 0.7 on amounts > 50,000 → `LOW_CONFIDENCE_LARGE_AMOUNT_REVIEW` ([policy.js:56-67](src/ai/policy.js#L56-L67)). The decision is `REVIEW` iff that list is non-empty, else `ALLOW` ([policy.js:118](src/ai/policy.js#L118)).
- **AI can never open a gate.** The only opener is `resolveReview` (approve/deny) ([saga.js:231-250](src/saga.js#L231-L250)), and its effect is enforced in `attempt()` before any money moves ([saga.js:288-295](src/saga.js#L288-L295)).
- **The JSON boundary drops anything executable.** `validateAIOutput` requires the union schema: exact `risk_level` enum, booleans typed, `reason_codes` from the frozen 13-code `REASON_CODES` enum, and a validated `structured_intent` (`validateStructuredIntent` — `INVALID_EXPECTED_AMOUNT`, `INVALID_CURRENCY`, `INVALID_TITLE`, etc.) ([schema.js:1-52](src/ai/schema.js#L1-L52)). `safeParseJSON` tolerates fenced marks but nothing else ([schema.js:54-60](src/ai/schema.js#L54-L60)).
- **Analyzer failure fails open at the interpreter but not in the policy.** If `analyze()` throws, the server sets `aiResult = null` and continues ([server.js:126-130](src/server.js#L126-L130)); `validateAndEvaluatePolicy(null, request)` runs the same hard rules and flags the result `ANALYZER_UNAVAILABLE` ([policy.js:115](src/ai/policy.js#L115), [policy.js:136-142](src/ai/policy.js#L136-L142)). Money still passes only if every deterministic gate is absent — and no gate can be suppressed by the absence.

Interpreter internals (for the boundary, not the money): `MockRiskAnalyzer` is rule-based (`defaultRules`, keyword regexes matched first-wins) ([risk-analyzer.js:13-34](src/ai/risk-analyzer.js#L13-L34), [risk-analyzer.js:224-261](src/ai/risk-analyzer.js#L224-L261)); `LLMRiskAnalyzer` is a thin client for OpenAI-compatible/Gemini endpoints with bounded retry on 429/5xx/timeout ([risk-analyzer.js:54-74](src/ai/risk-analyzer.js#L54-L74)) and strict `_parseValidated` (parse → `validateAIOutput`, exception on invalid) ([risk-analyzer.js:136-142](src/ai/risk-analyzer.js#L136-L142)); the system prompt explicitly tells the model the structured intent is an *interpretation, never an authorization* ([risk-analyzer.js:145-176](src/ai/risk-analyzer.js#L145-L176)).

> README: [### Why This Boundary Exists](README.md#why-this-boundary-exists), [## What is implemented](README.md#what-is-implemented)

## 3. Verification: the 8-check invariant verifier

`SagaEngine.verify()` lives in `src/verifier.js` and returns `{ invariantPass, status, checks }` ([verifier.js:18-69](src/verifier.js#L18-L69)).

| Check | Definition (code) |
|---|---|
| `noDuplicateDebit` | at most 1 DEBIT entry ([verifier.js:41](src/verifier.js#L41)) |
| `moneyConserved` | computed from DEBIT/REFUND entry totals: `debitTotal - refundTotal === (SUCCEEDED ? amount : 0)`; `UNKNOWN` external status is exempt ([verifier.js:42](src/verifier.js#L42), totals at [verifier.js:20-23](src/verifier.js#L20-L23)) — net zero after a full refund is a pass, not a loss |
| `validTerminalState` | state in `TERMINAL_STATES` (`SUCCEEDED`/`REFUNDED`/`FAILED`) or safely-unresolved `EXTERNAL_UNKNOWN` ([verifier.js:43](src/verifier.js#L43), [verifier.js:5](src/verifier.js#L5)) |
| `validPausedState` | *lawful review pause*, verified strictly from state: `CREATED` + `review.status === 'PENDING'` + external `NOT_CREATED` + no `paymentId` + no `orderId` + zero DEBIT/REFUND entries + ledger debit/credit both 0 ([verifier.js:30-40](src/verifier.js#L30-L40), [verifier.js:44](src/verifier.js#L44)) |
| `stateConsistent` | state in `VALID_STATES` (the 9-vertex state graph) ([verifier.js:45](src/verifier.js#L45), [verifier.js:1-4](src/verifier.js#L1-L4)) |
| `retryWasBlocked` | if a retry was attempted, saga must sit in `EXTERNAL_UNKNOWN` ([verifier.js:46](src/verifier.js#L46)) — reported in `checks`, deliberately **excluded** from `invariantPass` ([verifier.js:49-54](src/verifier.js#L49-L54)) |
| `refundIdempotent` | at most 1 REFUND entry ([verifier.js:47](src/verifier.js#L47)) |
| `oneDebitPerPayment` | distinct `paymentId`s across DEBIT entries ([verifier.js:48](src/verifier.js#L48)) |

`invariantPass = every moneyStateCheck && (validTerminalState || validPausedState)` ([verifier.js:55-57](src/verifier.js#L55-L57)). The `status` verdict is what callers render: `PASS` (settled clean), `AWAITING_REVIEW` (verified lawful pause — explicitly not a blanket pass for `CREATED`), or `FAIL` ([verifier.js:58-67](src/verifier.js#L58-L67)). The allowed-transition graph is authoritative for what "resting where it shouldn't" means ([verifier.js:6-16](src/verifier.js#L6-L16)).

The adversarial benchmark and scorecard re-assert this boundary: `src/ai/adversarial-benchmark.js` drives the real store+saga+rail (not a policy stub) and asserts observed money outcomes; `tests/safety-scorecard.test.js` re-derives the consolidated row every run.

> README: [## What is implemented](README.md#what-is-implemented) ("8-check Invariant Verifier"), [### Observed safety scorecard](README.md#observed-safety-scorecard-consolidated-provenance-labeled)

## 4. Durability across a real process restart

- **One file, one commit point.** `data/sagas.db` (server default) holds `sagas` (snapshot + integer `version` + UNIQUE `idempotency_key`), `rail_payments` (provider/attempt/order ids, amount, status, refund bookkeeping), and `events` ([store.js:62-95](src/store.js#L62-L95) — with tolerant in-place column migrations for older databases, [store.js:79-99](src/store.js#L79-L99)).
- **The saga snapshot and the external rail truth commit in the same transaction.** `save()` wraps `BEGIN IMMEDIATE`, upserts the saga snapshot **and** the rail payment row **and** any pending event row, then `COMMIT` ([store.js:272-309](src/store.js#L272-L309)). There is no window on disk where the saga and its payment diverge. `PRAGMA journal_mode=DELETE` + SQLite rollback journal makes a mid-transaction kill roll back to the last committed transition ([store.js:61](src/store.js#L61)).
- **Fail-loud on unreadable state.** A non-empty file whose 16-byte header is not `SQLite format 3` refuses to start with `PERSISTED_STATE_CORRUPT` ([store.js:49-57](src/store.js#L49-L57)); an unparseable saga snapshot does the same ([store.js:147-157](src/store.js#L147-L157)); a failed open closes the leaked handle so Windows can still delete/rebuild the file ([store.js:103-112](src/store.js#L103-L112)). Legacy `.json` stores are migrated in place ([store.js:124-145](src/store.js#L124-L145)).
- **Hydration is one-shot.** The store reads `sagas` and `rail_payments` at construction ([store.js:147-176](src/store.js#L147-L176)); a live process cannot see sagas created after that point by another process. Only the payment journal is replaced on hydration — the simulator's transient `_failMode` never persists ([store.js:171-174](src/store.js#L171-L174), quote at [rail.js:31-45](src/rail.js#L31-L45)).

**Proof in the repo — two independent mechanisms:**

1. **Demo (demo/crash-recovery-run.js + demo/crash-recovery.js):** the runner spawns `crash-recovery.js` as a *separate OS process* per stage (`spawnSync`, `STAGE` env) ([demo/crash-recovery-run.js:9-15](demo/crash-recovery-run.js#L9-L15)). Phase 1 uses rail `failMode: 'crash_after_success'` → `attempt()` parks the saga at `EXTERNAL_UNKNOWN` with a real persisted payment ([demo/crash-recovery.js:13-24](demo/crash-recovery.js#L13-L24)); an operator rewrites the durable rail truth to `SUCCEEDED` and `store.save()`s it before the simulated crash / `process.exit(0)` ([demo/crash-recovery.js:30-37](demo/crash-recovery.js#L30-L37)). Phase 2 opens the same DB in a brand-new process with a fresh rail, reloads, reconciles via `attempt()`, and asserts `SUCCEEDED` + exactly one ₹1500 debit + `invariantPass true` ([demo/crash-recovery.js:39-81](demo/crash-recovery.js#L39-L81)).
2. **Tests (tests/process-restart.test.js):** real SIGKILL, not simulated. The test spawns `src/server.js` as a child, reaches `EXTERNAL_UNKNOWN` (and the `RECONCILING` checkpoint), kills it with `SIGKILL`, starts a brand-new process against the same `DATA_DIR`, and asserts `SUCCEEDED` + exactly one debit + `invariantPass true` from the persisted store alone ([tests/process-restart.test.js:67-90](tests/process-restart.test.js#L67-L90), second arm at [tests/process-restart.test.js:92-121](tests/process-restart.test.js#L92-L121)).

> README: [### Durability across a real process restart](README.md#durability-across-a-real-process-restart), [## Demo: crash recovery](README.md#demo-crash-recovery)

## 5. Concurrency: in-process lock, process-local version map, SQLite write serialization

- **In-process lock.** `withLock(sagaId, fn)` throws `CONCURRENT_ACCESS` on re-entry and serializes per-saga work in one process ([store.js:182-190](src/store.js#L182-L190)); the server wraps every saga operation in it ([server.js:61](src/server.js#L61), [server.js:68](src/server.js#L68), etc.).
- **The version map is ordinary in-memory state, not a SQLite guard.** `this._versions = {}` is a plain JS object on each `Store` ([store.js:34](src/store.js#L34)) — seeded once at hydration from the committed rows ([store.js:147-155](src/store.js#L147-L155)) and advanced only when *this* instance commits. It is process-local: two processes never share it, so by itself it can protect only concurrent calls *within a single running process*. Its role is to hold the local *expected* version; the authoritative value is the committed `sagas.version` column.
- **The write transaction is the actual guard.** `save()` starts `BEGIN IMMEDIATE` ([store.js:272](src/store.js#L272)), re-reads the committed `version` row from the file inside that write transaction ([store.js:274](src/store.js#L274)), and if `row.version !== expectedVersion` (the local map) rolls back and throws `concurrentAccessError` ([store.js:275-277](src/store.js#L275-L277)) — a stale writer is rejected, never last-writer-wins. The error carries `code: 'CONCURRENT_ACCESS'` and the message `CONCURRENT_ACCESS: saga store was modified by another process (stale writer rejected). Reload the store and retry.` ([store.js:21-27](src/store.js#L21-L27)). SQLite's `BEGIN IMMEDIATE` writer lock serializes writers ([store.js:314-322](src/store.js#L314-L322), design note at [store.js:1-13](src/store.js#L1-L13)); the fresh in-transaction re-read then exposes any divergence between a stale per-process map and the committed row.
- **Precise boundary, including across processes.** Two processes on the same file are *not* coordinated by the in-memory map — it exists once per process; a second process is protected only at write time, and only because SQLite serializes writers and each writer re-reads committed truth inside its own write transaction. A process that hydrated an old version and commits later therefore loses the race and is rejected rather than silently overwriting. Confirmed empirically: two independent `Store` instances on one file both hydrate version 1, the first commits to version 3, and the second's stale write fails with `code: 'CONCURRENT_ACCESS'` — the same outcome the multi-process test asserts below.
- **Begins race via the UNIQUE idempotency key.** Two processes beginning the same key: one inserts, the other trips `ERR_SQLITE_CONSTRAINT_UNIQUE`, re-reads the winner's row, and returns `duplicate: true` (with `AMOUNT_MISMATCH` on conflicting amounts) ([store.js:214-243](src/store.js#L214-L243)); a benign duplicate begin returns the existing saga ([store.js:199-207](src/store.js#L199-L207)).
- **Proven by a multi-process test** that races two live servers and asserts: the stale writer gets a `CONCURRENT_ACCESS`-style error (never `ENOENT`, never silent success), exactly one saga row and one rail payment exist on disk, and a fresh process recovers deterministically ([tests/process-restart.test.js:123-181](tests/process-restart.test.js#L123-L181)).

This is serialization at the point of write, **not** a distributed lock: the losing writer is rejected and must reload/retry, not queued or merged ([store.js:314-322](src/store.js#L314-L322)).

> README: [### Concurrency](README.md#concurrency)

## 6. AI evaluation (AI-EVAL-0.1) — recomputed from the cache

Rather than transcribing numbers from `README.md`, the figures below were recomputed from the actual artifacts: the frozen dataset in `src/ai/eval-dataset.js`, the live cache payloads in `src/ai/cache/*-final-eval.json`, and the repository's own evaluator (`src/ai/evaluate.js`).

**Dataset provenance** (`DATASET_PROVENANCE`, [eval-dataset.js:255-287](src/ai/eval-dataset.js#L255-L287); header commentary [eval-dataset.js:5-42](src/ai/eval-dataset.js#L5-L42)):

| Set | n | Distribution | Status |
|---|---|---|---|
| dev | 60 | 30 LOW / 18 AMBIG / 12 HIGH ([eval-dataset.js:45-111](src/ai/eval-dataset.js#L45-L111)) | development use only ([eval-dataset.js:7-12](src/ai/eval-dataset.js#L7-L12)) |
| heldout | 40 | 20 / 12 / 8 ([eval-dataset.js:121-167](src/ai/eval-dataset.js#L121-L167)) | **contaminated** — rules were tuned on it; original 95.0% / 91.7% HIGH recall, now 100% but not unbiased ([eval-dataset.js:13-22](src/ai/eval-dataset.js#L13-L22), [eval-dataset.js:266-275](src/ai/eval-dataset.js#L266-L275)) |
| final | 45 | 20 / 17 / 8 (17 AMBIGUOUS includes 5 hard negatives) ([eval-dataset.js:185-243](src/ai/eval-dataset.js#L185-L243), [eval-dataset.js:276-286](src/ai/eval-dataset.js#L276-L286)) | **frozen**, created after the classifier freeze; no failures tuned ([eval-dataset.js:24-30](src/ai/eval-dataset.js#L24-L30)) |

**Mock classifier (deterministic baseline)** — recomputed by running the repo's own `evaluate(new MockRiskAnalyzer(), getFinalTestSet())` ([evaluate.js:6-22](src/ai/evaluate.js#L6-L22), [evaluate.js:24-92](src/ai/evaluate.js#L24-L92)):

```
total=45  correct=37  accuracy=82.2%
LOW_RISK    P=86.4%  R=95.0%  F1=90.5%  TP=19 FP=3 FN=1
AMBIGUOUS   P=85.7%  R=70.6%  F1=77.4%  TP=12 FP=2 FN=5
HIGH_RISK   P=66.7%  R=75.0%  F1=70.6%  TP=6  FP=3 FN=2
macro       F1=79.5% P=79.6%  R=80.2%
```

These match `README.md`'s valid final result exactly (accuracy 82.2%, macro F1 79.5%, HIGH P 66.7% / R 75.0%, TP6 FP3 FN2). This is the one complete, valid, comparable number in the section — see the frozen failure analysis in [README.md:210-230](README.md#valid-final-test-result) for the two structural-risk misses and three keyword false positives.

**Live cache audit** (counts recomputed by parsing the JSON; per-example `raw`/`parsed`/`error` shapes recorded keyed by example id):

| Provider (model) | Records in file | Valid (raw+parsed) | Schema-rejected | Transport failures | Label match on valid |
|---|---|---|---|---|---|
| Gemini (`gemini-3.6-flash`) | 32 (`final_0..final_31`) — 13 never attempted (`final_32..final_44`) | 7 (`final_0,2,3,5,6,8,13`) | 4 (`final_4,10,12,14` — reason codes outside the frozen `REASON_CODES` enum) | 3 timeout `final_7,9,11`; 18 quota-429 `final_1,15..31` | 7/7 (all classified LOW_RISK, matching frozen labels) |
| Groq (`qwen/qwen3.8-27b`) | 45 (`final_0..final_44`) | 26 | 19 = 15× `INVALID_EXPECTED_AMOUNT` + 3× `INVALID_TITLE` + 1× `INVALID_CURRENCY` | 0 | 26/26 |

Groq per-class completion: LOW 20/20, AMBIGUOUS 2/17, HIGH 4/8; the four unrealized HIGH cases are exactly `final_34,36,37,38`, the completed ones `final_32,33,35,39`. Aggregate summary in [README.md:250-254](README.md#live-llm-evaluation). Validation rules that produce these rejections are in [schema.js:15-52](src/ai/schema.js#L15-L52).

> README: [### Evaluation (AI-EVAL-0.1)](README.md#evaluation-ai-eval-01) (incl. [Contamination Disclosure](README.md#contamination-disclosure) and [Live LLM Evaluation](README.md#live-llm-evaluation))

## 7. What this is not

- **Not a real payment rail.** `PaymentRailSimulator` "performs no real money movement" and has no real-gateway idempotency agreement — only the coded de-dup rules ([rail.js:4-6](src/rail.js#L4-L6)). It synthesizes `order_`/`pay_`/`ref_` ids ([rail.js:15-16](src/rail.js#L15-L16), [rail.js:64](src/rail.js#L64)), is idempotent via `_findPayment` and rejects amount mismatches with `AMOUNT_MISMATCH` ([rail.js:22-29](src/rail.js#L22-L29), [rail.js:71-73](src/rail.js#L71-L73)), and its `_failMode` is a transient submit-time injection, restored immediately — never durable truth ([rail.js:31-45](src/rail.js#L31-L45), [rail.js:48-55](src/rail.js#L48-L55), [store.js:171-174](src/store.js#L171-L174)). A Razorpay Test/Mode adapter would replace it; none exists ([README.md:424-427](README.md#razorpay-integration)). The contract a real rail must prove is pinned by `tests/rail-contract.test.js` ([README.md:335-347](README.md#paymentrail-contract-suite)).
- **Not an AI planner.** `MockRiskAnalyzer` is a keyword classifier (default) ([risk-analyzer.js:13-34](src/ai/risk-analyzer.js#L13-L34)); `LLMRiskAnalyzer` is a thin API client, no chain-of-thought, no tool use ([risk-analyzer.js:36-74](src/ai/risk-analyzer.js#L36-L74)). The README diagram's "AI planner" slot is explicitly not occupied ([README.md:103](README.md#why-this-boundary-exists)).
- **Not a production webhook integration.** No provider client, retry queue, TLS termination, or provider-side registration; events are recorded/absorbed, never money-movers by themselves ([server.js:173-196](src/server.js#L173-L196), [README.md:442-444](README.md#webhook--event-boundary)).
- **Not a distributed lock.** The `_versions` map is a per-process in-memory object ([store.js:34](src/store.js#L34)); concurrency protection is in-process, and cross-process is the SQLite write-transaction re-read at write time, with rejected losers that must reload ([store.js:1-13](src/store.js#L1-L13), [store.js:314-322](src/store.js#L314-L322), [README.md:428-432](README.md#concurrency)).
- **Not a throughput/latency test.** The benchmark measures deterministic in-process behavior and retry-guard soundness, explicitly not performance ([README.md:454-462](README.md#benchmark)).

## 8. Findings / discrepancies (maintainers to resolve)

These are deliberately not papered over here:

1. **README test count (corrected).** The README previously claimed 255; it now states **259/259**, matching this checkout (including the uncommitted `tests/dashboard-flow.test.js` and the committed `tests/verifier.test.js` additions). A bare checkout of committed HEAD (without the uncommitted test file) runs 257/257.
2. **Review-approve-then-stop API window.** A saga gated `REVIEW` that is `approve`d via the API but then handled only through a subsequent stop (no further HTTP call) still verifies `FAIL` rather than `AWAITING_REVIEW`, because the paused-state check strictly requires `review.status === 'PENDING'` ([verifier.js:30-40](src/verifier.js#L30-L40)). The dashboard button path eliminates this in practice by calling approve-then-attempt ([static/app.js:89-94](static/app.js#L89-L94)); the API-only window remains. Coverage is honest but scoped: the **server-side** review-approve/attempt flow (the API path) is exercised by `tests/dashboard-flow.test.js`; the dashboard's Continue Saga **button's client-side wiring** is **not** covered by an automated test and was verified manually only.

## 9. Repo map (the modules quoted above)

| Concern | File |
|---|---|
| HTTP boundary, static UI, webhook ingress | `src/server.js` ([server.js:55-206](src/server.js#L55-L206)) |
| Saga state machine, review gate, compensation | `src/saga.js` |
| SQLite store: transactions, CAS, migration, hydration | `src/store.js` |
| Payment rail simulation | `src/rail.js`, `src/payment.js` |
| Hard rules, facts, gate derivation | `src/ai/policy.js` |
| AI schema / JSON boundary | `src/ai/schema.js` |
| Analyzers (mock default, LLM clients) | `src/ai/risk-analyzer.js` |
| Evaluator + dataset + provenance | `src/ai/evaluate.js`, `src/ai/eval-dataset.js` |
| Live evaluation cache | `src/ai/cache/gemini-final-eval.json`, `src/ai/cache/groq-final-eval.json` |
| 8-check verifier | `src/verifier.js` |
| Crash-recovery demo (new-process) | `demo/crash-recovery-run.js`, `demo/crash-recovery.js` |
| SIGKILL + multi-process CAS tests | `tests/process-restart.test.js` |
| Dashboard | `static/index.html`, `static/app.js`, `static/styles.css` |