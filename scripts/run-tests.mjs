#!/usr/bin/env node
// 带硬超时的单元测试入口。node --test 的 --test-timeout 管不到测试文件的加载阶段：
// 顶层 await 永不结束时进程会一直挂着。这里按文件起子进程，超时杀掉整个进程组并记为失败。
import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const FILE_TIMEOUT_MS = Number(process.env.PI_WEB_TEST_FILE_TIMEOUT_MS) || 3 * 60_000;
const TOTAL_TIMEOUT_MS = Number(process.env.PI_WEB_TEST_TOTAL_TIMEOUT_MS) || 30 * 60_000;
const CASE_TIMEOUT_MS = 90_000;
// 默认只并发 2 个文件：每个文件都要加载 TypeScript，开多了会占满机器。
const CONCURRENCY = Math.max(1, Number(process.env.PI_WEB_TEST_CONCURRENCY) || 2);

const args = process.argv.slice(2);
const files = args.length > 0
  ? args
  : ["app", "components", "hooks", "lib", "public"].flatMap((dir) => globSync(`${dir}/**/*.test.mjs`)).sort();

const startedAt = Date.now();
const results = [];
let next = 0;
let running = 0;
const children = new Set();

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function count(output, label) {
  const match = output.match(new RegExp(`^ℹ ${label} (\\d+)`, "m"));
  return match ? Number(match[1]) : 0;
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--test",
      `--test-timeout=${CASE_TIMEOUT_MS}`,
      "--test-force-exit",
      file,
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, FILE_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({
        file,
        timedOut,
        code,
        output,
        pass: count(output, "pass"),
        fail: count(output, "fail"),
        skipped: count(output, "skipped"),
        ms: 0,
      });
    });
  });
}

function report(interrupted) {
  const failed = results.filter((result) => result.timedOut || result.code !== 0);
  for (const result of failed) {
    console.log(`\n✖ ${result.file}${result.timedOut ? ` (超过 ${FILE_TIMEOUT_MS / 1000}s，已杀掉)` : ""}`);
    const summary = result.output.split("✖ failing tests:")[1] ?? result.output;
    console.log(summary.split("\n").filter((line) => !/^\s+at /.test(line)).slice(0, 60).join("\n"));
  }
  const sum = (key) => results.reduce((total, result) => total + result[key], 0);
  const timedOut = results.filter((result) => result.timedOut).map((result) => result.file);
  console.log(`\n文件 ${results.length}/${files.length}，通过 ${sum("pass")}，失败 ${sum("fail")}，跳过 ${sum("skipped")}，超时文件 ${timedOut.length}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
  if (timedOut.length > 0) console.log(`超时：${timedOut.join(" ")}`);
  if (interrupted) console.log(`整轮超过 ${TOTAL_TIMEOUT_MS / 1000}s，未跑完的文件被放弃。`);
  process.exit(failed.length > 0 || interrupted ? 1 : 0);
}

const totalTimer = setTimeout(() => {
  for (const child of children) killGroup(child);
  report(true);
}, TOTAL_TIMEOUT_MS);

await new Promise((resolve) => {
  const pump = () => {
    if (next >= files.length && running === 0) {
      resolve();
      return;
    }
    while (running < CONCURRENCY && next < files.length) {
      const file = files[next++];
      running += 1;
      void runFile(file).then((result) => {
        results.push(result);
        running -= 1;
        if (result.timedOut || result.code !== 0) console.log(`✖ ${file}`);
        pump();
      });
    }
  };
  pump();
});
clearTimeout(totalTimer);
report(false);
