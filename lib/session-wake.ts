import { existsSync } from "node:fs";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "./session-reader";

/**
 * Wake a session from the server: reopen it when its wrapper was reaped (the
 * page closed, the idle timeout passed, pi-web restarted) and deliver a
 * displayed custom message that starts a turn, the way a background subagent
 * reports back (lib/subagent-runtime.ts). Used by scheduled tasks and
 * background commands.
 *
 * `followUp` waits until the running turn has finished all its work; `steer`
 * is read after the current tool calls and can change what the model is doing.
 * An idle session starts a turn either way.
 */

export type WakeDelivery = "followUp" | "steer";

/** How long a wake waits for the turn to start before it counts as delivered. */
const DELIVERY_START_WAIT_MS = 2_000;

export class SessionWakeError extends Error {
  /** The target is gone for good; a recurring source should stop. */
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.name = "SessionWakeError";
    this.permanent = permanent;
  }
}

async function openSession(sessionId: string): Promise<AgentSessionWrapper> {
  let session = getRpcSession(sessionId);
  if (session?.isAlive() && session.diskFreshness() !== "current") {
    if (session.isRunning() || !session.evictIfDiskAhead()) {
      throw new SessionWakeError("the session file was changed outside pi-web");
    }
    session = undefined;
  }
  if (!session?.isAlive()) {
    const sessionFile = await resolveSessionPath(sessionId);
    if (!sessionFile) throw new SessionWakeError("the session no longer exists", true);
    ({ session } = await startRpcSession(sessionId, sessionFile, undefined));
  }
  return session;
}

export interface WakeSessionInput {
  sessionId: string;
  cwd: string;
  customType: string;
  content: string;
  details?: unknown;
  delivery: WakeDelivery;
  /** Called if the turn the wake started fails after the wake already resolved. */
  onLateError?: (error: unknown) => void;
}

/** Resolves once the turn started or the message was queued; throws SessionWakeError or the SDK's error. */
export async function wakeSession(input: WakeSessionInput): Promise<void> {
  if (!existsSync(input.cwd)) throw new SessionWakeError(`the project directory ${input.cwd} no longer exists`);
  const session = await openSession(input.sessionId);
  await session.waitUntilReady();
  if (!session.isAlive()) throw new SessionWakeError("the session closed before the message could be delivered");
  const delivery = session.inner.sendCustomMessage({
    customType: input.customType,
    content: input.content,
    display: true,
    details: input.details,
  }, { deliverAs: input.delivery, triggerTurn: true });
  // pi resolves only once the turn it started settles, which can take a long time.
  // A failure surfaces quickly; after that the message counts as delivered.
  const settled = await Promise.race([
    delivery.then(() => "done" as const),
    new Promise<"started">((resolve) => { setTimeout(() => resolve("started"), DELIVERY_START_WAIT_MS); }),
  ]);
  if (settled === "started") delivery.catch((error: unknown) => input.onLateError?.(error));
  invalidateSessionListCache();
}
