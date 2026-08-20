import { LatestContextLoader } from "./latest-context-loader";

const loader = new LatestContextLoader();

void loader.run("session", async () => "value", (value) => value);

// @ts-expect-error commit 必须同步，异步回调会破坏 latest 检查与状态提交的原子性。
void loader.run("session", async () => "value", async (value) => value);
