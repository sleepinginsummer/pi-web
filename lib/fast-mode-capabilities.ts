/** 已确认能够接受并转发 `service_tier: "priority"` 的 provider。 */
const FAST_MODE_PROVIDER_ALLOWLIST: ReadonlySet<string> = new Set([
  "openai",
  "sleepinsum-0.08",
  "sleepinsum-0.16",
  "sleepinsum-0.22",
  "sleepinsum-test",
]);

export function isFastModeProviderAllowed(provider: string): boolean {
  return FAST_MODE_PROVIDER_ALLOWLIST.has(provider);
}
