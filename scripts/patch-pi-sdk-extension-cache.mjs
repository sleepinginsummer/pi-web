import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchPiSdkExtensionCache } from "../lib/pi-sdk-extension-cache-patch.mjs";

// 每个版本都已逐字核对 extensions/loader 的缓存段与补丁替换源一致。
const REVIEWED_SDK_VERSIONS = new Set(["1.1.0", "1.2.0"]);
const sdkEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkRoot = dirname(dirname(sdkEntryPath));
const packageJsonPath = join(sdkRoot, "package.json");
const loaderPath = join(sdkRoot, "dist", "core", "extensions", "loader.js");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const sdkVersion = String(packageJson.version);
if (!REVIEWED_SDK_VERSIONS.has(sdkVersion)) {
  throw new Error(
    `Pi SDK extension cache patch was reviewed for ${[...REVIEWED_SDK_VERSIONS].join(", ")}, found ${sdkVersion}. Review or remove the patch before upgrading.`,
  );
}

const original = readFileSync(loaderPath, "utf8");
const result = patchPiSdkExtensionCache(original);
if (result.status === "already-patched") {
  console.log(`[pi-web] Pi SDK ${sdkVersion} multi-cwd extension cache already patched`);
  process.exit(0);
}

const temporaryPath = `${loaderPath}.pi-web-tmp`;
try {
  writeFileSync(temporaryPath, result.source, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, loaderPath);
} finally {
  rmSync(temporaryPath, { force: true });
}
console.log(`[pi-web] patched Pi SDK ${sdkVersion} with bounded multi-cwd extension cache`);
