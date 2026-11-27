import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const BASH = existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash";

// 全部系统操作替换为临时目录内的命令，不接触真实 launchctl 作业与端口。
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-service-test-"));
  const tools = join(root, "tools");
  const pkg = join(root, "package with spaces");
  const runtime = join(root, "runtime with spaces");
  mkdirSync(tools);
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  mkdirSync(join(pkg, ".next"));
  mkdirSync(runtime);
  copyFileSync(new URL("../scripts/macos-service.sh", import.meta.url), join(pkg, "scripts", "macos-service.sh"));
  writeFileSync(join(pkg, ".next", "BUILD_ID"), "test");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "test-version" }));
  writeFileSync(join(runtime, "service.env"), "PI_WEB_PASSWORD='test $ and spaces'\nPI_WEB_ALLOWED_HOSTS=pi.znzme.com\n", { mode: 0o600 });
  const mocks = {
    uname: "#!/bin/bash\necho Darwin\n",
    launchctl: '#!/bin/bash\nprintf "%s\\n" "$1" >> "$MOCK_LOG"\ncase "$1" in\nlist) test -f "$MOCK_JOB";;\nsubmit) touch "$MOCK_JOB";;\nremove) rm -f "$MOCK_JOB";;\nesac\n',
    lsof: '#!/bin/bash\nif [ -f "$MOCK_JOB" ] || [ "${MOCK_BUSY:-}" = 1 ]; then echo 12345; else exit 1; fi\n',
    curl: "#!/bin/bash\nexit 0\n",
    sleep: "#!/bin/bash\nexit 0\n",
  };
  for (const [name, content] of Object.entries(mocks)) writeFileSync(join(tools, name), content, { mode: 0o700 });

  // 模拟 launchctl submit 作业的 PATH 时不能借用 /usr/bin、/bin 这类系统目录：
  // 有些 CI 镜像本来就在那里放了 node，用例就不再确定。只放脚本解析 node 之前真正用到的命令，
  // node 只能由我们自己决定有没有。
  const nodeFreeBin = join(root, "node-free-bin");
  mkdirSync(nodeFreeBin);
  symlinkSync(BASH, join(nodeFreeBin, "bash"));
  // 脚本只调用一次 `dirname "$0"`，自带实现比依赖宿主目录更稳定。
  writeFileSync(join(nodeFreeBin, "dirname"), '#!/bin/bash\nprintf "%s\\n" "${1%/*}"\n', { mode: 0o700 });

  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    PI_WEB_RUNTIME_ROOT: runtime,
    MOCK_LOG: join(root, "calls"),
    MOCK_JOB: join(root, "job"),
  };
  const script = join(pkg, "scripts", "macos-service.sh");
  return {
    root,
    tools,
    runtime,
    env,
    nodeFreePath: `${tools}:${nodeFreeBin}`,
    run: (shell, action, extra = {}) => spawnSync(shell, [script, action], { env: { ...env, ...extra }, encoding: "utf8" }),
    calls: () => (existsSync(env.MOCK_LOG) ? readFileSync(env.MOCK_LOG, "utf8") : ""),
  };
}

for (const shell of ["/bin/bash", "bash"]) {
  test(`服务脚本在 ${shell} 下处理含空格路径并拒绝未知端口占用`, { skip: process.platform === "win32" }, () => {
    const fixture = createFixture();
    const run = (action, extra) => fixture.run(shell, action, extra);
    try {
      const started = run("start");
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /监听 PID：12345，端口：8081/);
      const launcher = readFileSync(join(fixture.runtime, "run.sh"), "utf8");
      assert.ok(launcher.includes("package\\ with\\ spaces"));
      assert.ok(!launcher.includes("test $ and spaces"), "密码应通过配置文件读取，不放进进程启动参数");
      assert.equal(spawnSync(BASH, ["-n", join(fixture.runtime, "run.sh")]).status, 0);
      assert.equal(run("start").status, 1, "不能重复注册同名作业");
      assert.equal(run("restart").status, 0);
      assert.equal(run("stop").status, 0);
      const callsBefore = fixture.calls();
      assert.equal(run("start", { MOCK_BUSY: "1" }).status, 1);
      assert.equal(run("stop", { MOCK_BUSY: "1" }).status, 1);
      const newCalls = fixture.calls().slice(callsBefore.length);
      assert.ok(!newCalls.includes("remove"), "未知进程不能触发删除作业");
      assert.ok(!newCalls.includes("submit"), "端口未释放不能提交新服务");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  // launchctl submit 提交的作业只有系统 PATH。这种环境下 restart 必须先确认能启动：
  // 先 stop 再发现缺 node，会让一次失败的更新连带停掉一个本来健康的正式服务。
  test(`服务脚本在 ${shell} 下缺 node 时重启不停机`, { skip: process.platform === "win32" }, () => {
    const fixture = createFixture();
    try {
      const probe = spawnSync(shell, ["-c", "command -v node"], { env: { ...fixture.env, PATH: fixture.nodeFreePath }, encoding: "utf8" });
      assert.notEqual(probe.status, 0, "用例 PATH 里不能有 node，否则缺 node 分支没有被覆盖");

      const started = fixture.run(shell, "start");
      assert.equal(started.status, 0, started.stderr);
      const callsBefore = fixture.calls();
      const restarted = fixture.run(shell, "restart", { PATH: fixture.nodeFreePath });
      assert.equal(restarted.status, 1);
      assert.match(restarted.stderr, /PATH 中找不到 node/);
      assert.ok(!restarted.stdout.includes("已停止"), "缺少 node 时不能先停掉正在运行的服务");
      const newCalls = fixture.calls().slice(callsBefore.length);
      assert.ok(!newCalls.includes("remove"), "缺少 node 时不能先停掉正在运行的服务");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
