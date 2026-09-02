const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const BUILD_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-\d+$/;

function parseComparableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version) ?? BUILD_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = STABLE_VERSION_PATTERN.test(candidate)
    ? parseComparableVersion(candidate)
    : null;
  const currentParts = parseComparableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export function getPiWebReleaseUrl(version: string): string | null {
  if (!STABLE_VERSION_PATTERN.test(version)) return null;
  return `https://github.com/agegr/pi-web/releases/tag/v${version}`;
}
