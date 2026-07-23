import { beginRequestActivity, endRequestActivity, updateRequestActivityRoute } from "./request-activity";
import type { RequestIdentity } from "./request-identity";
import type { RequestRouteObservation } from "./request-activity";

export interface ActivityHookSet {
  onIdentityResolved: (identity: RequestIdentity) => void;
  onRouteResolved: (observation: RequestRouteObservation) => void;
  cleanup: () => void;
}

export function createActivityHooks(requestId: string, start: number): ActivityHookSet {
  return {
    onIdentityResolved: identity => beginRequestActivity(requestId, start, identity),
    onRouteResolved: observation => updateRequestActivityRoute(requestId, observation),
    cleanup: () => endRequestActivity(requestId),
  };
}
