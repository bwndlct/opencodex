# Phase 4.1 — Forward MCP (namespace) + apply_patch tools to chat models

Status: DONE (MCP + apply_patch). Verified incl. live e2e.
Date: 2026-06-19
Work class: C3 (cross-module: parser + adapter + bridge + server; tool round-trip protocol)

## Problem
The `openai-chat` path (go models like glm) only forwarded `type:"function"` tools — `parser.ts buildTools`
dropped the other 8 of Codex's 21 tools. So glm never received MCP tools (computer_use, context7,
node_repl, gmail), apply_patch, tool_search, web_search, image_generation.

## Finding (independent reviewer, source-cited)
- Codex routes a returned MCP call by an explicit **`namespace` field** on the function_call item
  (`protocol/src/models.rs:789`, `core/src/tools/router.rs:96` builds `ToolName::new(namespace, name)`),
  NOT by parsing a delimited name. Registry lookup is exact on `(namespace, name)`
  (`registry.rs:331/449`; tests `router_tests.rs:147`, `registry_tests.rs:136`).
- MCP tools arrive as `{type:"namespace", name:"<NS>", tools:[{type:"function", name:"<TOOL>", parameters}]}`
  — inner tools are already function-shaped, so flattenable.
- `tool_search`/`web_search`/`image_generation` are hosted/client tools with no opencode.ai equivalent → keep dropping.
- `apply_patch` is freeform `custom`; returning it as a `function_call` triggers a FATAL turn-abort
  (handler accepts only `ToolPayload::Custom`, `apply_patch.rs:302/443`). Needs a `custom_tool_call`
  emit path + live verification → deferred.

## Implementation (round-trip)
- `types.ts`: `OcxTool.namespace?` + `OcxToolCall.namespace?` + `namespacedToolName(ns, name)` helper
  (synthetic wire name `"<NS>__<TOOL>"`).
- `parser.ts buildTools`: flatten `namespace` tools → function `OcxTool`s carrying `namespace`; read
  `namespace` off incoming `function_call` items (multi-turn history).
- `openai-chat.ts`: send the synthetic name for tool defs AND assistant-history tool calls.
- `server.ts`: build `Map<syntheticName → {namespace, name}>` from parsed tools; pass to the bridge.
- `bridge.ts`: on emit, resolve synthetic → real `name` + add top-level `namespace` field so Codex routes it.

apply_patch (freeform `custom`):
- `parser.ts buildTools`: `type:"custom"` → function tool with `{input:string}` schema + `freeform:true`.
- `server.ts`: collect `freeformToolNames`; pass to bridge.
- `bridge.ts`: for freeform tools, emit a `custom_tool_call` item (type/name/input) instead of `function_call`,
  unwrapping the model's `{input}` arg to the raw patch; suppress the function_call_arguments delta.

## Verification
- `bun x tsc --noEmit` → clean.
- Unit (`/tmp/mcp-test.ts`, real src modules): parsed tools = [exec_command, mcp__context7::query_docs,
  mcp__context7::resolve_library_id]; apply_patch/tool_search/web_search dropped; chat tools sent =
  ["exec_command","mcp__context7__query_docs","mcp__context7__resolve_library_id"]; round-trip
  function_call item = `{name:"query_docs", namespace:"mcp__context7", arguments:{...}}` ✅.
- Regression: glm (deepseek-v4-pro) returns `REG_OK` with a namespace+custom tool in the body (no break).
- gpt-5.5 smoke `GPT_OK` (passthrough path unaffected).

## apply_patch verification (live e2e — the gate)
`codex exec -m opencode-go/glm-5.2 "Use the apply_patch tool to create /tmp/apt_e2e.txt containing APT_E2E_OK"`
→ glm authored a patch, the bridge relayed it as a `custom_tool_call`, Codex applied it, and the file was
created with exactly `APT_E2E_OK`. Combined unit test confirms MCP (function_call+namespace) and apply_patch
(custom_tool_call+raw patch) round-trips coexist; web_search dropped.

## Deferred / out of scope
- **tool_search / web_search / image_generation**: hosted/client tools; no opencode.ai equivalent. Intentionally dropped.

## Note
Full end-to-end (glm actually invoking an MCP tool through Codex) depends on the model choosing to call it;
the proxy-side format is proven correct (unit + Codex source routing). MCP tools also only appear when the
relevant MCP servers are connected in the user's Codex session.
