import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchPiSdkExtensionCache } from "../lib/pi-sdk-extension-cache-patch.mjs";

const EXPECTED_SDK_VERSION = "0.84.3";
const sdkEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkRoot = dirname(dirname(sdkEntryPath));
const packageJsonPath = join(sdkRoot, "package.json");
const loaderPath = join(sdkRoot, "dist", "core", "extensions", "loader.js");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== EXPECTED_SDK_VERSION) {
  throw new Error(
    `Pi SDK extension cache patch requires ${EXPECTED_SDK_VERSION}, found ${String(packageJson.version)}. Review or remove the patch before upgrading.`,
  );
}

const original = readFileSync(loaderPath, "utf8");
const result = patchPiSdkExtensionCache(original);
if (result.status === "already-patched") {
  console.log(`[pi-web] Pi SDK ${EXPECTED_SDK_VERSION} multi-cwd extension cache already patched`);
  process.exit(0);
}

const temporaryPath = `${loaderPath}.pi-web-tmp`;
try {
  writeFileSync(temporaryPath, result.source, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, loaderPath);
} finally {
  rmSync(temporaryPath, { force: true });
}
console.log(`[pi-web] patched Pi SDK ${EXPECTED_SDK_VERSION} with bounded multi-cwd extension cache`);
