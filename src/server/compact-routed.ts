import { formatErrorResponse } from "../bridge";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { buildCompactV1Output, decodeCompactionSummary, extractCompactUserMessages } from "../responses/compaction";
import { isFixedEffort } from "../model-route-overrides";
import type { ModelRouteOverrideResult } from "../model-route-overrides";
import type { OcxConfig } from "../types";
import type { RequestLogContext } from "./request-log";
import type { RequestIdentity } from "./request-identity";
import { handleResponses } from "./responses";

/**
 * Routed compact uses the same synthetic turn as the v2 compaction path. Keeping this in a
 * helper lets combo targets enter handleComboResponses directly, without a speculative
 * routeModel/pickComboTarget call that would advance selection twice.
 */
export async function runRoutedCompactRequest(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  raw: Record<string, unknown>,
  inputItems: unknown[],
  identity: RequestIdentity,
  routeOverride?: ModelRouteOverrideResult,
): Promise<Response> {
  const internalBody: Record<string, unknown> = {
    ...raw,
    stream: false,
    input: [...inputItems, { type: "compaction_trigger" }],
  };
  if (routeOverride && isFixedEffort(routeOverride.effort)) {
    internalBody.reasoning = { effort: routeOverride.effort };
  }
  const internalHeaders = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) internalHeaders.set(name, value);
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify(internalBody),
  });
  const response = await handleResponses(internalReq, config, logCtx, {
    abortSignal: req.signal,
    identityOverride: identity,
    ...(routeOverride ? { routeOverride } : {}),
  });
  if (!response.ok) return response;
  let json: { output?: unknown[] };
  try {
    json = await response.json() as { output?: unknown[] };
  } catch {
    return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
  }
  const compactionItem = (json.output ?? []).find(
    (item): item is { type: string; encrypted_content?: string } =>
      !!item && typeof item === "object" && (item as { type?: string }).type === "compaction",
  );
  const summary = compactionItem?.encrypted_content
    ? decodeCompactionSummary(compactionItem.encrypted_content) ?? ""
    : "";
  const output = buildCompactV1Output(extractCompactUserMessages(inputItems), summary);
  return new Response(JSON.stringify({ output }), { headers: { "Content-Type": "application/json" } });
}
