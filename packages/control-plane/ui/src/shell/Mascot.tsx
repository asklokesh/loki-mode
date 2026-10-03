// Loki mascot: a rounded app window with a friendly face, drawn from design tokens. Eyes take the accent while any run is running.
export function Mascot({ active = false, size = 26 }: { active?: boolean; size?: number }) {
  const eye = active ? "var(--cp-accent)" : "var(--cp-text)";
  return (
    <svg data-testid="mascot" data-state={active ? "active" : "idle"} role="img" aria-label={active ? "Loki, working" : "Loki"} width={size} height={size} viewBox="0 0 32 32">
      <rect x="3" y="4" width="26" height="22" rx="6" fill="var(--cp-card)" stroke="var(--cp-accent)" strokeWidth="2" />
      <path d="M3 10h26" stroke="var(--cp-accent)" strokeWidth="1.5" opacity="0.5" />
      <circle cx="12" cy="17" r="2" fill={eye} />
      <circle cx="20" cy="17" r="2" fill={eye} />
      <path d="M12.5 21.5c2 1.6 5 1.6 7 0" fill="none" stroke="var(--cp-text)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 26v3M22 26v3" stroke="var(--cp-accent)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
