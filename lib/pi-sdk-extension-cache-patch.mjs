const PATCH_MARKER = "pi-web-multi-cwd-extension-cache-v1";

const REPLACEMENTS = [
  {
    from: `let extensionCacheCwd;
let extensionCacheGeneration = 0;
const extensionCache = new Map();`,
    to: `const PI_WEB_EXTENSION_CACHE_PATCH = "${PATCH_MARKER}";
const MAX_EXTENSION_CACHE_CWDS = 8;
let extensionCacheGeneration = 0;
const extensionCache = new Map();
const extensionCacheCwds = [];`,
  },
  {
    from: `export function clearExtensionCache() {
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
}`,
    to: `export function clearExtensionCache() {
    extensionCache.clear();
    extensionCacheCwds.length = 0;
    extensionCacheGeneration++;
}
function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    const existingIndex = extensionCacheCwds.indexOf(resolvedCwd);
    if (existingIndex >= 0) extensionCacheCwds.splice(existingIndex, 1);
    extensionCacheCwds.push(resolvedCwd);
    while (extensionCacheCwds.length > MAX_EXTENSION_CACHE_CWDS) {
        const evictedCwd = extensionCacheCwds.shift();
        const prefix = \`${"${evictedCwd}"}\\0\`;
        for (const key of extensionCache.keys()) {
            if (key.startsWith(prefix)) extensionCache.delete(key);
        }
    }
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}`,
  },
  {
    from: `function isCurrentCacheToken(cacheToken) {
    return (cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation);
}`,
    to: `function isCurrentCacheToken(cacheToken) {
    return (cacheToken !== undefined &&
        extensionCacheGeneration === cacheToken.generation &&
        extensionCacheCwds.includes(cacheToken.cwd));
}
function extensionCacheKey(cacheToken, extensionPath) {
    return \`${"${cacheToken.cwd}"}\\0${"${extensionPath}"}\`;
}`,
  },
  {
    from: `        const cachedFactory = extensionCache.get(extensionPath);`,
    to: `        const cachedFactory = extensionCache.get(extensionCacheKey(cacheToken, extensionPath));`,
  },
  {
    from: `        extensionCache.set(extensionPath, factory);`,
    to: `        extensionCache.set(extensionCacheKey(cacheToken, extensionPath), factory);`,
  },
];

export function patchPiSdkExtensionCache(source) {
  if (source.includes(PATCH_MARKER)) return { source, status: "already-patched" };

  let patched = source;
  for (const { from, to } of REPLACEMENTS) {
    const firstIndex = patched.indexOf(from);
    if (firstIndex < 0 || patched.indexOf(from, firstIndex + from.length) >= 0) {
      throw new Error("Pi SDK extension cache source does not match the reviewed 0.84.3 layout");
    }
    patched = patched.replace(from, to);
  }
  return { source: patched, status: "patched" };
}

export { PATCH_MARKER };
