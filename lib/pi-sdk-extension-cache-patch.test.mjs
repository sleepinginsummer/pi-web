import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PATCH_MARKER, patchPiSdkExtensionCache } from "./pi-sdk-extension-cache-patch.mjs";

const ORIGINAL_0842_FIXTURE = `
const resolvePath = (value) => value;
let extensionCacheCwd;
let extensionCacheGeneration = 0;
const extensionCache = new Map();
export function clearExtensionCache() {
    extensionCache.clear();
    extensionCacheCwd = undefined;
    extensionCacheGeneration++;
}
function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
        clearExtensionCache();
    }
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}
function isCurrentCacheToken(cacheToken) {
    return (cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation);
}
async function loadExtensionModule(extensionPath, cacheToken) {
    if (isCurrentCacheToken(cacheToken)) {
        const cachedFactory = extensionCache.get(extensionPath);
        if (cachedFactory) return cachedFactory;
    }
    const factory = () => {};
    if (isCurrentCacheToken(cacheToken)) {
        extensionCache.set(extensionPath, factory);
    }
    return factory;
}
`;

function assertModuleSyntax(source) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-sdk-patch-"));
  const file = join(directory, "loader.mjs");
  try {
    writeFileSync(file, source, "utf8");
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("transforms the reviewed 0.84.3 source into a valid bounded per-cwd cache", () => {
  const result = patchPiSdkExtensionCache(ORIGINAL_0842_FIXTURE);

  assert.equal(result.status, "patched");
  assert.match(result.source, new RegExp(PATCH_MARKER));
  assert.match(result.source, /MAX_EXTENSION_CACHE_CWDS = 8/);
  assert.match(result.source, /extensionCacheCwds\.includes\(cacheToken\.cwd\)/);
  assert.match(result.source, /extensionCacheKey\(cacheToken, extensionPath\)/);
  assert.doesNotMatch(result.source, /extensionCacheCwd = resolvedCwd/);
  assertModuleSyntax(result.source);

  const second = patchPiSdkExtensionCache(result.source);
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, result.source);
});

test("installed SDK carries the reviewed patch marker", () => {
  const loaderPath = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url);
  const packagePath = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
  assert.match(readFileSync(loaderPath, "utf8"), new RegExp(PATCH_MARKER));
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).version, "0.84.3");
});

test("fails closed when the reviewed SDK source layout changes", () => {
  assert.throws(
    () => patchPiSdkExtensionCache("export const changedUpstream = true;"),
    /does not match the reviewed 0\.84\.3 layout/,
  );
});
