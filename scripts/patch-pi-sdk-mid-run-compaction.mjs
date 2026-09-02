import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchPiSdkMidRunCompaction } from "../lib/pi-sdk-mid-run-compaction-patch.mjs";

const EXPECTED_SDK_VERSION = "0.84.3";
const sdkEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkRoot = dirname(dirname(sdkEntryPath));
const packageJsonPath = join(sdkRoot, "package.json");
const agentSessionPath = join(sdkRoot, "dist", "core", "agent-session.js");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== EXPECTED_SDK_VERSION) {
  throw new Error(
    `Pi SDK mid-run compaction patch requires ${EXPECTED_SDK_VERSION}, found ${String(packageJson.version)}. Review or remove the patch before upgrading.`,
  );
}

const original = readFileSync(agentSessionPath, "utf8");
const result = patchPiSdkMidRunCompaction(original);
if (result.status === "already-patched") {
  console.log(`[pi-web] Pi SDK ${EXPECTED_SDK_VERSION} mid-run compaction already patched`);
  process.exit(0);
}

const temporaryPath = `${agentSessionPath}.pi-web-tmp`;
try {
  writeFileSync(temporaryPath, result.source, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, agentSessionPath);
} finally {
  rmSync(temporaryPath, { force: true });
}
console.log(`[pi-web] patched Pi SDK ${EXPECTED_SDK_VERSION} with mid-run auto-compaction`);
