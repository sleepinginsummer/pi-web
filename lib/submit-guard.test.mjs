import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SubmitGuard } = await jiti.import("./submit-guard.ts");

test("a submission is only stopped by the guard after Stop voided it", () => {
  const guard = new SubmitGuard();
  const ticket = guard.begin(3);

  assert.equal(guard.guardInput({ source: "rpc", text: "hello" }), false, "nothing was cancelled yet");
  assert.equal(guard.cancelInFlight(), true, "Stop voids the submission pi still holds");
  assert.equal(ticket.cancelled, true);
  assert.equal(guard.cancelInFlight(), false, "a second Stop voids nothing more");

  assert.equal(guard.guardInput({ source: "extension", text: "hello" }), false, "only this host's own submissions");
  // 前面的钩子可以用 transform 改写正文，所以认的是「谁的提交」而不是文字。
  assert.equal(guard.guardInput({ source: "rpc", text: "hello, rewritten by an input hook" }), true);
  assert.equal(ticket.swallowed, true, "pi is told the submission was handled");
});

test("the guard forgets a submission pi already took", () => {
  const guard = new SubmitGuard();
  const first = guard.begin(1);
  guard.end(first);
  assert.equal(guard.cancelInFlight(), false, "nothing is in flight after pi took it");

  // 下一条派发覆盖上一条：残留的票据既不能被 Stop 作废，也不能拦下别人的消息。
  const stale = guard.begin(2);
  const live = guard.begin(3);
  assert.equal(guard.cancelInFlight(), true);
  assert.equal(stale.cancelled, false, "the replaced ticket is not the one Stop voids");
  assert.equal(guard.guardInput({ source: "rpc", text: "live" }), true);
  assert.equal(live.swallowed, true);
  guard.end(live);
  assert.equal(guard.cancelInFlight(), false);
});
