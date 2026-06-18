# Implementation log — Phase 1 + 2 (DONE, verified live)

Built across two PABCD rounds. Round 1 = Phase 1 core sidecar; Round 2 = hardening from an
independent Backend-employee review.

## What shipped

`src/web-search/` module:
- `synthetic-tool.ts` — `extractHostedWebSearch` (stash hosted config) + `buildWebSearchTool` (the
  function the chat model calls) + `WEB_SEARCH_TOOL_NAME`.
- `executor.ts` — `runWebSearch`: one search via gpt-5.4-mini through the ChatGPT forward backend,
  reusing the caller's `FORWARD_HEADERS`. Never throws (returns `{error}`).
- `parse.ts` — `parseSidecarSSE`: ChatGPT Responses SSE → `{text, sources}`.
- `format-result.ts` — outcome → tool_result text (graceful on error).
- `loop.ts` — `runWithWebSearch` agentic loop + `scanEventsForWebSearch`.
- `index.ts` — `planWebSearch` gating + defaults.

Wiring: `parser.ts` stashes `parsed._webSearch`; `server.ts` `handleResponses` runs the loop when
`planWebSearch` is active; `openai-responses.ts` exports `FORWARD_HEADERS`; `types.ts` adds the types.

## Runtime findings (from live testing against the ChatGPT backend)

- **`store: false` is REQUIRED** — the backend 400s otherwise (`"Store must be set to false"`).
- **`reasoning.effort: "minimal"` is REJECTED with web_search** (`"tools cannot be used with
  reasoning.effort 'minimal'"`). Sidecar default is **`"low"`** — the lightest viable effort, closest
  to the requested "non-thinking" intent while actually running.
- The sidecar returns sources **inline in the answer text** (markdown links); structured
  `url_citation` annotations came back empty in testing → structured-source passthrough is deferred
  (Phase 3/4). The main model still sees the sources in the injected tool_result text.

## Round 2 hardening (3 review findings, all fixed in loop.ts)

1. **Empty-answer at cap** → forced-answer pass (drop the web_search tool so the model must answer).
2. **Mixed web_search + real tool call** → `hasRealToolCall` finalizes instead of looping, so real
   tool calls (shell/apply_patch) reach Codex instead of being dropped.
3. **`maxSearchesPerTurn` semantics** → now caps TOTAL searches via a counter, not loop rounds.

## Verified

- `claude-sonnet-4-6` + `web_search` → sidecar searched → answered **"Bun 1.3.14"** (correct, current).
- No-`web_search` request → unchanged streaming path.
- `web_search` with NO ChatGPT auth → sidecar skipped, turn completes (no broken tool exposed).
- Security (review): only `FORWARD_HEADERS` forwarded; no token logging; gating sound. `tsc` clean.

## Config (`OcxConfig.webSearchSidecar`, all optional — default-on)

`enabled` (default on when a forward provider + auth exist) · `model` (gpt-5.4-mini) ·
`reasoning` (low) · `maxSearchesPerTurn` (3) · `timeoutMs` (30000).

## Remaining (Phase 3-5, not yet built)

- Structured source/citation passthrough (`annotations` on final `output_text`).
- Real-time `web_search_call` in_progress/completed events to the Codex TUI (currently the search
  iterations are non-streamed; only the final answer streams).
- `open_page` / `find_in_page` actions; domain-filter/search_context_size replay is already passed
  through verbatim via the stashed hosted tool.
- GUI indicator + per-provider toggles + requestLog sidecar tagging.
