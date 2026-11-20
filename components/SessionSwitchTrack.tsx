export function SessionSwitchTrack({ checked, pending = false }: { checked: boolean; pending?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        width: 22,
        height: 12,
        flexShrink: 0,
        borderRadius: 999,
        background: checked ? "var(--accent)" : "color-mix(in srgb, var(--border) 92%, var(--text-dim))",
        opacity: pending ? 0.55 : 1,
        transition: "background 0.15s, opacity 0.15s",
      }}
    >
      <span style={{
        position: "absolute",
        top: 2,
        left: checked ? 12 : 2,
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--bg)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.22)",
        transition: "left 0.15s",
      }} />
    </span>
  );
}
