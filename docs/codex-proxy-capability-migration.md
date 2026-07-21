# Codex Proxy Capability Migration

Status: active

Baseline date: 2026-07-21

- OpenCodex: `main@5afd49a`
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
| Per-Session `inherit` / `personal_first` policy | Completed in `8349d72` | Batch 3D |
| Effective upstream and fallback observability | Completed in the current batch | Batch 3E |
| Session workspace/dashboard controls | Missing | Batch 3F, after backend contracts stabilize |
| Personal Codex account pool | Existing and broader in OpenCodex | Gap audit only; do not port wholesale |
| First-output retry, stall timeout, cancellation | Existing but different implementation | Phase 4 parity audit, patch only proven gaps |
| Usage/cache/tool accounting | Existing detailed usage and attempt records | Phase 4 parity audit, patch only proven gaps |
| Incident history and health classification | Partial through logs/debug/health | Phase 5 gap audit |
| macOS deployment hardening | OpenCodex has its own service/update lifecycle | Audit native path; do not copy proxy scripts |
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

Status: completed in the current batch.

- Add effective upstream and stable fallback reason to the root-Session snapshot.
- Keep requested provider/model separate from effective provider/model.
- Clear stale fallback state after recovery.
- Keep completed request logs and live Session activity as separate data sets.

### Batch 3F: Session Workspace UI

Status: pending.

- Add a work-focused Session view backed by the stable 3B-3E APIs.
- Show main/child activity, effective upstream, fallback state, and route policy.
- Keep route controls available for valid Sessions regardless of the current
  provider; do not encode model-specific locks.
- Verify desktop and mobile layouts with browser screenshots.

### Phase 4: Reliability and Accounting Parity

Status: pending.

- Compare pre-first-output retry, stream commit, stall, cancellation, and shutdown
  behavior against codex-proxy.
- Compare reported/estimated/missing usage, cache tokens, tool calls, and retry
  attempts.
- Patch only reproducible gaps. Preserve OpenCodex's provider-generic architecture.
- Add failure-path tests before changing retry or accounting semantics.

### Phase 5: Diagnostics and Incident Parity

Status: pending.

- Compare redacted request logs, debug buffers, health classification, and incident
  retention against codex-proxy.
- Add only diagnostics that answer a concrete hidden-failure question.
- Keep bounded local retention and privacy scanning as hard gates.

### Phase 6: Capability Closure Audit

Status: pending.

- Re-run the matrix against the then-current `codex-proxy/main` and OpenCodex HEAD.
- Mark each capability equivalent, migrated, intentionally excluded, or blocked.
- Run typecheck, privacy scan, focused suites, and the full source suite.

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

Formal deployment is not implied by source completion.

- Build from a clean pushed commit.
- Run an isolated port canary first.
- Verify source commit, installed artifact, process identity, health, and behavior as
  separate gates.
- Preserve rollback artifacts.
- Modify the formal service or Codex configuration only with explicit deployment
  authority.

## Batch Completion Contract

For every Batch:

1. Sol maps the plan to current files and freezes write ownership.
2. Luna confirms the scope before editing, then implements only the approved Batch.
3. Luna runs focused tests and reports changed files and residual risk.
4. Sol reviews the complete diff and runs independent focused and broad gates.
5. Sol commits and pushes a passing Batch as its own checkpoint.
6. The next Batch starts only from a clean, pushed baseline.
