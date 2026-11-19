import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEFAULT_PENDING_NEW_SESSION_CONTROL } = await jiti.import("@/lib/pending-new-session");

export function forkAgentHookOptions(options) {
  return {
    navigationKey: 1,
    isNavigationActive: () => true,
    pendingNewSessionControl: DEFAULT_PENDING_NEW_SESSION_CONTROL,
    onPendingNewSessionEvent() {},
    t: (key) => key,
    ...options,
  };
}

export function sessionMaterializationReply(sessionId, command, state = {}) {
  if (command.operation === "create") return { kind: "runtime-created", success: true, sessionId };
  return { kind: "ready", success: true, sessionId, shadowMindEnabled: false, shadowMindAvailable: false, data: {}, ...state };
}
