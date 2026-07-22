# Codex Proxy Capability Migration

Status: source migration complete through OpenAI dual-upstream routing and SIGHUP
reload; isolated Z.AI and formal company OpenAI canaries passed; dual-route,
maximum-reasoning, and updated-service canaries remain pending. OpenCodex is
already deployed on `127.0.0.1:8787`, but not yet with Phases 8-10.

Baseline date: 2026-07-22

- OpenCodex implementation baseline: `main@aae4493`
- codex-proxy: `main@9518cd1`

## Goal

Use `codex-proxy/main` as the capability baseline, keep OpenCodex as the runtime,
and migrate only capabilities that are still useful and not already implemented
more completely in OpenCodex.

Sol owns architecture, batch scope, integration, review, validation, commits, and
pushes. Luna executes one bounded batch at a time. A batch must pass its focused
gate before the next batch starts.

## Non-goals

- Do not port the Go Responses-to-Anthropic converter. OpenCodex already has a
  native provider and adapter architecture.
- Do not port GLM Broker or OpenCode job execution into OpenCodex.
- Do not duplicate OpenCodex's existing Codex/OAuth account pools, key pools,
  provider management, usage JSONL, retry framework, or service manager.
- Do not restore forced Terra-to-GLM routing.
- Do not make SQLite, containers, or a Broker-owned tool executor prerequisites.
- Do not mix real Z.AI validation, source migration, and formal deployment into
  one acceptance gate.

## Capability Matrix

| codex-proxy capability | OpenCodex status | Migration decision |
| --- | --- | --- |
| Z.AI through Anthropic protocol | Existing provider support; isolated canary passed | Configure and validate, no duplicate adapter |
| GLM model metadata | Static catalog supported | Completed as isolated metadata configuration |
| Request/session identity | Missing before Batch 3A | Completed in `5afd49a` |
| Root Session active-request aggregation | Completed in `cedf128` | Batch 3B |
| Main/child account affinity by root Session | Completed in `911f8d8` | Batch 3C |
| Per-Session `inherit` / `personal_first` / `company_first` policy | Completed in `8349d72`, extended in Phase 8 | Batch 3D plus dual-upstream routing |
| Effective upstream and fallback observability | Completed in `f5e40af` | Batch 3E |
| Session workspace/dashboard controls | Completed in `f6acbcd` | Batch 3F |
| Personal Codex account pool | Existing and broader in OpenCodex | Gap audit only; do not port wholesale |
| Company OpenAI Responses upstream | Found during shadow deployment audit | `passthrough` source path and isolated real canary complete |
| Personal-pool/company dual-upstream fallback | Present in codex-proxy | Migrated in Phase 8; real dual-route canary pending |
| First-output retry, stall timeout, cancellation | Equivalent or stronger after Phase 4 audit | No migration patch required |
| Luna ordinary-turn reasoning forced to max | Missing before Phase 10 | Migrated with exact model matching and legacy exemptions |
| Usage/cache/tool accounting | Equivalent or stronger fields; bounded retention completed in `26d4174` | Completed |
| Incident history and health classification | Completed in `2be98d6` and `908439b` | Migrated as retained incident projection plus local health report |
| Drain readiness | Completed in `6cdd92e` | Migrated |
| Bounded service and crash diagnostics | Completed in `b2b8260` and `c0c00e0` | Migrated with native OpenCodex service lifecycle |
| macOS deployment hardening | OpenCodex has its own cross-platform service/update lifecycle | Equivalent; do not copy proxy scripts |
| GLM Broker lifecycle and sandbox | Not needed in the target architecture | Intentionally excluded |

## Invariants

- Missing identity remains absent; never create an `unknown` or localized sentinel.
- Root Session is `parentThreadId ?? executionSessionId`.
- Execution Session remains available for tracing even when activity aggregates to
  the root.
- Child-marker behavior uses exact wire values; logging normalization must not
  change routing or effort behavior.
- Request completion, failure, timeout, cancellation, and stream teardown release
  activity exactly once.
- No prompt, response body, tool arguments, credentials, or raw account IDs are
  added to logs or persisted usage.
- Cleanup, logging, or diagnostics failures must not replace a valid model result.
- Existing provider routing, authentication, payloads, and retry behavior remain
  unchanged unless the active batch explicitly names and tests the change.

## Source Migration Phases

### Phase 1: Upstream Baseline

Status: completed.

- Clean upstream install, typecheck, privacy scan, and baseline tests recorded.
- Isolated OpenCodex instance reached Z.AI through the Anthropic endpoint.
- Text, tools, namespace tools, custom tools, cancellation, CLI flow, and workspace
  CRUD were exercised without source patches.

### Phase 2: Provider Metadata and Real-Provider Separation

Status: source/config path completed; high-concurrency real validation remains in
the separate real-provider track.

- Use `authMode: "key"` and `x-api-key` behavior already supplied by OpenCodex.
- Use the existing static catalog for `zai-anthropic/glm-5.2` with a 1,000,000
  token context window.
- Do not add a Z.AI-specific provider implementation unless a real protocol gap is
  reproduced.

### Batch 3A: Request Identity and Durable Logs

Status: completed and pushed as `5afd49a`.

- Parse explicit execution/root/parent/request/subagent/model/effort identity.
- Project validated optional fields into request logs and usage JSONL.
- Preserve parse-normalized model/effort for ordinary requests.
- Preserve identity through a real local Combo target attempt.

### Batch 3B: Live Root Session Activity

Status: completed and pushed as `cedf128`.

- Add an in-memory request-activity registry keyed by request ID and aggregated by
  root Session.
- Preserve execution Session IDs as bounded activity detail.
- Start after request identity is decoded; release exactly once on non-stream
  completion, stream terminal, failure, cancellation, or unexpected exception.
- Expose a read-only management API snapshot so the registry has an immediate
  consumer. Do not add GUI, persistence, provider routing, or account policy.
- Prove the production lifecycle with concurrent main + child requests and the
  `2 -> 1 -> 0` active-count transition.

### Batch 3C: Root Session Account Affinity

Status: completed and pushed as `911f8d8`.

- Reuse Batch 3A identity for Codex account selection.
- Bind a main request and its children to the same root Session account.
- Preserve existing expiry, cooldown, quota re-evaluation, and fail-closed behavior.
- Do not add new account storage or policy controls.

### Batch 3D: Per-Session Route Policy

Status: completed and pushed as `8349d72`.

- Add `inherit | personal_first` as a persisted root-Session policy.
- Use atomic, owner-only local persistence and corruption-safe startup behavior.
- Add guarded GET/PUT management endpoints.
- A request-scoped fallback must not mutate the global next-session preference.
- Do not expose credentials or raw provider account identifiers.

### Batch 3E: Session Routing Observability

Status: completed and pushed as `f5e40af`.

- Add effective upstream and stable fallback reason to the root-Session snapshot.
- Keep requested provider/model separate from effective provider/model.
- Clear stale fallback state after recovery.
- Keep completed request logs and live Session activity as separate data sets.

### Batch 3F: Session Workspace UI

Status: completed in `f6acbcd`.

- Add a work-focused Session view backed by the stable 3B-3E APIs.
- Show main/child activity, effective upstream, fallback state, and route policy.
- Keep route controls available for valid Sessions regardless of the current
  provider; do not encode model-specific locks.
- Verify desktop and mobile layouts with browser screenshots.

### Phase 4: Reliability and Accounting Parity

Status: completed in `26d4174`.

- The reliability audit found OpenCodex equivalent or stronger for pre-first-output
  retry, semantic stream commit, stall handling, cancellation, shutdown/drain, and
  request cleanup. No reliability patch was justified.
- Accounting already distinguishes reported, estimated, and missing usage; records
  cache and reasoning tokens, request and attempt TTFT, physical attempts, recovery
  kinds, and terminal close reasons.
- Replace new writes to the unbounded `usage.jsonl` with local-date shards under
  `usage/`, retaining 30 calendar days. Continue reading the legacy file without
  rewriting it.
- Pruning is best-effort, once per local day, and touches only strict valid shard
  names. Unknown files, directories, and the cutoff-day shard are preserved.

### Phase 5: Diagnostics and Incident Parity

Status: completed through `908439b`.

- Add `/api/incidents` as a bounded, redacted projection over retained usage shards;
  do not duplicate a second incident store.
- Add `/api/drain` as a read-only view of the existing graceful-drain lifecycle.
- Put launchd, systemd, Task Scheduler, and WinSW behind one internal
  `service-runner`. It captures the real proxy child's stdout/stderr and rotates
  `service.log` during the same long-lived process at 5 MiB with four backups.
- Bound `crash.log` synchronously at 5 MiB with two backups so process-level
  diagnostics remain best-effort and available inside exception handlers.
- Add authenticated `/api/health` with relay, default-provider configuration, and
  incident-history components. It performs no upstream probe and exposes no path,
  request, provider URL, account, or credential material.
- Keep `/healthz` as cheap process identity/liveness, `/api/drain` as readiness, and
  `/api/providers/test` as the explicit active upstream probe.
- Existing usage-debug retention was already bounded and required no patch.

### Phase 6: Capability Closure Audit

Status: completed against codex-proxy `main@9518cd1` and OpenCodex `main@908439b`.

- The protocol/provider audit found native Anthropic translation, tool pairing,
  streaming, cancellation, metadata, and usage support equivalent or stronger.
- The request/runtime audit found identity, root-Session aggregation, account
  affinity, per-Session policy, retry, stall, cancellation, result preservation,
  and shutdown equivalent or migrated.
- The operations audit found incident history, drain readiness, bounded logs,
  health classification, service lifecycle, and runtime identity equivalent or
  migrated after Phase 5.
- GLM Broker jobs, OpenCode sandbox profiles, VM/container isolation, orphaned
  OpenCode child cleanup, and Broker recovery remain intentionally excluded because
  OpenCodex does not host OpenCode jobs.
- Focused service/lifecycle gate: 88 pass, 0 fail. Phase 5 focused health/incident/
  drain gate: 18 pass, 0 fail. Typecheck and privacy scan pass.
- The final full source suite reached 3311 pass / 4 fail / 1 error across 287
  files. Three failures match the known local DNS/SSRF and user-config baseline;
  the fourth was a provider-management timeout. Its focused rerun passed, leaving
  56 pass / 2 known DNS/SSRF failures in that file and no new source regression.

### Phase 7: Company OpenAI Responses Compatibility

Status: source implementation, fake-upstream tests, isolated real canary, and
formal deployment complete.

- Add `authMode: "passthrough"` for a non-ChatGPT `openai-responses` endpoint.
- A non-`forward` `openai` provider preserves its configured base URL and bypasses
  Codex account-pool selection. Bare `gpt-*` model routing remains available.
- Forward the caller's Authorization, OpenAI organization/project, and Codex request
  metadata to `<baseUrl>/responses`; never forward `ChatGPT-Account-Id`.
- Preserve the caller's raw Responses body for this company route, including
  continuation and reasoning fields. Apply the same credential and body semantics to
  `/v1/responses/compact`.
- The canonical `authMode: "forward"` official ChatGPT provider and account-pool
  behavior remain unchanged.
- An isolated OpenCodex instance on `127.0.0.1:8788` completed a real Codex CLI
  request through the configured company Responses endpoint and returned the exact
  expected output. The formal `127.0.0.1:8787` service was not modified by this
  canary.
- The formal OpenCodex service on `127.0.0.1:8787` completed a real Codex CLI
  request through the company endpoint without a command-line base-URL override.
  The current Codex CLI first attempts WebSocket transport, receives `426`, and
  successfully falls back to HTTP.
- At Phase 7 completion this restored only the company-first path. The explicit
  dual-upstream policy and retry/credential-isolation work followed in Phase 8.

### Phase 8: OpenAI Dual-Upstream Routing

Status: source implementation and isolated tests complete; real dual-route canary
pending.

- `openAiDualUpstream` names the company `openai-responses` provider and persists a
  default `personal_first` or `company_first` policy. A root Session may override it
  with `inherit`, `personal_first`, or `company_first` without changing the global
  provider configuration.
- A personal-first request tries eligible personal accounts one at a time. Only
  authentication, unavailable-model, timeout, rate-limit, and upstream failures may
  advance to another account or the company endpoint; request-shape errors stop.
- A company-first request may fall back to the personal pool on the same bounded
  failure classes. Company credentials come only from the inbound request, while
  personal attempts use only the selected Codex account credential.
- Cross-upstream replay is allowed only before a response body produces its first
  byte. Empty or failed-before-output bodies are unavailable; once output is
  committed, later stream failure is returned to the caller and never replayed.
- Automatic default switching from personal-first to company-first is persisted only
  after the company fallback actually produces output. Failed company fallback does
  not change the default. Persistence compares the current disk policy first, so a
  request started before SIGHUP cannot overwrite a newer configuration snapshot.
- The same policy applies to `/v1/responses/compact`; compact responses are fully
  buffered before the selected upstream is committed.
- Request activity and attempt logs expose policy, effective upstream, and bounded
  fallback reason without account IDs or credentials.

### Phase 9: SIGHUP Configuration Reload

Status: source implementation and isolated tests complete; service canary pending.

- `SIGHUP` loads and validates a complete new configuration, then atomically swaps the
  snapshot used by future HTTP and WebSocket turns. In-flight requests retain their
  previous snapshot.
- Invalid configuration leaves the running snapshot untouched and reports a bounded
  error. Changes to hostname, port, or process-level proxy settings require a normal
  drain and restart.
- `SIGINT` and `SIGTERM` keep the existing graceful-drain behavior. The service
  launcher may continue forwarding `SIGHUP`; it no longer causes the child to exit.

### Phase 10: Luna and GLM Maximum Reasoning Policy

Status: source implementation and isolated tests complete; deployed canary pending.

- Ordinary requests whose requested model exactly matches `lunaReasoningMaxModels`
  are raised to `reasoning.effort: "max"`. The default exact set is
  `["gpt-5.6-luna"]`; an empty configured list disables the policy.
- Matching is trimmed and case-sensitive. Namespaced aliases and substring matches
  do not inherit the rule unless explicitly configured.
- `request_kind: "memory"`, explicit `low`, and already-`max` requests remain
  unchanged, matching the old proxy contract. The explicit-effort check covers both
  nested `reasoning.effort` and legacy top-level `reasoning_effort`.
- Rewrites keep parsed adapter options, nested raw Responses reasoning, and an
  existing legacy top-level field synchronized. Malformed nested reasoning is left
  unchanged instead of being silently repaired.
- An explicit global or subagent effort cap still wins after the Luna raise. This
  preserves OpenCodex's documented operator ceiling while keeping uncapped Luna
  turns equivalent to codex-proxy.
- Every request whose original routed model exactly matches `glmReasoningMaxModels`
  is raised to `reasoning.effort: "max"`, including memory and explicitly low-effort
  requests. The default exact set is `["zai-anthropic/glm-5.2"]`; an empty list
  disables the GLM policy.
- Matching GLM catalog rows advertise only `max` and use it as their default. This
  keeps Codex-side validation aligned with the runtime rewrite instead of exposing
  lower controls that OpenCodex will ignore.
- The Anthropic adapter's existing `max` mapping remains the wire contract. With the
  current 32,000-token output ceiling it emits the highest usable 27,904-token
  thinking budget and reserves 4,096 tokens for visible output. No Z.AI-specific
  protocol field is invented, and generated catalog/cache files remain owned by
  `ocx sync`.

## Real Z.AI Validation Track

This track is independent from source migration and may run only with an available
credential and quota. It must report mock/source success separately from provider
success.

- Text streaming and reasoning output.
- Single, multi-round, and parallel tool calls.
- Namespace and custom/apply-patch tools.
- Client cancellation and upstream socket closure.
- Workspace read/write/edit/delete.
- 429 and other terminal error behavior.
- Eight concurrent agents. A quota rejection is a provider-capacity result, not a
  source regression.
- Prompt-cache and 1,000,000-token metadata behavior.

## Deployment Track

Status: completed on 2026-07-22 from clean pushed commit `aae4493`.

- The immutable release is `~/.opencodex-releases/2.7.28-aae4493`.
- `com.opencodex.proxy` serves formal OpenCodex traffic on `127.0.0.1:8787`.
- `com.user.codex-proxy` remains on `127.0.0.1:8790` for GLM Broker's authenticated
  job-scoped Chat Completions route; Broker configuration was reloaded to that port.
- Formal non-streaming GLM, streaming GLM, company OpenAI, service restart, health,
  model-catalog, and Broker-route canaries passed.
- The isolated OpenCodex service on `127.0.0.1:8789` and the deployment backup under
  `~/.opencodex-deploy-backups/20260722-115143-aae4493` remain available for rollback.

## Batch Completion Contract

For every Batch:

1. Sol maps the plan to current files and freezes write ownership.
2. Luna confirms the scope before editing, then implements only the approved Batch.
3. Luna runs focused tests and reports changed files and residual risk.
4. Sol reviews the complete diff and runs independent focused and broad gates.
5. Sol commits and pushes a passing Batch as its own checkpoint.
6. The next Batch starts only from a clean, pushed baseline.
