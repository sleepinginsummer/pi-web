import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 全部系统操作替换为临时目录内的命令，不接触真实 launchctl 作业与端口。
for (const shell of ["/bin/bash", "bash"]) {
  test(`服务脚本在 ${shell} 下处理含空格路径并拒绝未知端口占用`, { skip: process.platform === "win32" }, () => {
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
    const env = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      PI_WEB_RUNTIME_ROOT: runtime,
      MOCK_LOG: join(root, "calls"),
      MOCK_JOB: join(root, "job"),
    };
    const run = (action, extra = {}) => spawnSync(shell, [join(pkg, "scripts", "macos-service.sh"), action], { env: { ...env, ...extra }, encoding: "utf8" });
    try {
      const started = run("start");
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /监听 PID：12345，端口：8081/);
      const launcher = readFileSync(join(runtime, "run.sh"), "utf8");
      assert.ok(launcher.includes("package\\ with\\ spaces"));
      assert.ok(!launcher.includes("test $ and spaces"), "密码应通过配置文件读取，不放进进程启动参数");
      assert.equal(spawnSync("/bin/bash", ["-n", join(runtime, "run.sh")]).status, 0);
      assert.equal(run("start").status, 1, "不能重复注册同名作业");
      assert.equal(run("restart").status, 0);
      assert.equal(run("stop").status, 0);
      const callsBefore = readFileSync(env.MOCK_LOG, "utf8");
      assert.equal(run("start", { MOCK_BUSY: "1" }).status, 1);
      assert.equal(run("stop", { MOCK_BUSY: "1" }).status, 1);
      const newCalls = readFileSync(env.MOCK_LOG, "utf8").slice(callsBefore.length);
      assert.ok(!newCalls.includes("remove"), "未知进程不能触发删除作业");
      assert.ok(!newCalls.includes("submit"), "端口未释放不能提交新服务");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
