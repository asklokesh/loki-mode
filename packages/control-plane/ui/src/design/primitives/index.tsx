// Control Plane design primitives (CPE-01). Every value is a --cp-* token from ../tokens.css.
import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

const t = (n: string) => `var(--cp-${n})`;
const cx = (...p: Array<string | false | undefined>) => p.filter(Boolean).join(" ") || undefined;

export type Tone = "success" | "warning" | "error" | "info" | "neutral";
const TONE_BG: Record<Tone, string> = {
  success: t("success-muted"), warning: t("warning-muted"), error: t("error-muted"), info: t("info-muted"), neutral: t("bg-3"),
};
const TONE_FG: Record<Tone, string> = {
  success: t("success-ink"), warning: t("warning-ink"), error: t("error-ink"), info: t("info-ink"), neutral: t("text-2"),
};

/* Card */
export function Card({ interactive, compact, style, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean; compact?: boolean }) {
  return (
    <div
      {...rest}
      data-cp="card"
      data-interactive={interactive ? "true" : undefined}
      className={cx("cp-card", className)}
      style={{
        background: t("card"), border: `1px solid ${t("border")}`, borderRadius: t("radius-lg"),
        padding: compact ? 10 : 16, transition: `transform ${t("dur-fast")} ${t("ease")}, box-shadow ${t("dur-fast")} ${t("ease")}`,
        ...(interactive ? { cursor: "pointer", boxShadow: t("shadow-sm") } : null), ...style,
      }}
    >
      {children}
    </div>
  );
}

/* KpiTile: value is mono; the sparkline renders only when a real series is supplied */
export function KpiTile({ label, value, icon, trend, trendTone = "neutral", series, compact }: {
  label: string; value: ReactNode; icon?: ReactNode; trend?: string; trendTone?: Tone; series?: number[]; compact?: boolean;
}) {
  const pts = series && series.length > 1 ? series : null;
  let spark: ReactNode = null;
  if (pts) {
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
    const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 80).toFixed(1)} ${(22 - ((v - lo) / span) * 20).toFixed(1)}`).join(" ");
    spark = (
      <svg data-cp="sparkline" width={80} height={24} viewBox="0 0 80 24" aria-hidden="true">
        <path d={d} fill="none" stroke={t("accent")} strokeWidth={1.5} />
      </svg>
    );
  }
  return (
    <Card data-cp-kind="kpi" style={{ padding: compact ? "10px 12px" : "14px 16px", display: "flex", gap: 10, alignItems: "center" }}>
      {icon ? <span style={{ width: 28, height: 28, borderRadius: 6, background: t("accent-muted"), color: t("accent"), display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{icon}</span> : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: t("text-sm"), color: t("text-2") }}>{label}</div>
        <div style={{ fontFamily: t("font-mono"), fontSize: compact ? 20 : 28, fontWeight: 500, lineHeight: 1.2 }}>{value}</div>
      </div>
      {trend ? <span style={{ fontSize: 11, borderRadius: 3, padding: "1px 6px", background: TONE_BG[trendTone], color: TONE_FG[trendTone] }}>{trend}</span> : null}
      {spark}
    </Card>
  );
}

/* Badge and the verdict map */
export const VERDICT_TONE: Record<string, Tone> = {
  VERIFIED: "success", PARTIAL: "warning", FAILED: "error", SPEC_CONFLICT: "info", BLOCKED: "info", running: "neutral",
  TAMPERED: "error", UNSIGNED: "warning", NOT_VERIFIED: "warning", UNCHECKED: "warning",
};

/** Verdict names. UI code outside primitives refers to verdicts through this, never through a bare string. */
export const VERDICT = { VERIFIED: "VERIFIED", PARTIAL: "PARTIAL", FAILED: "FAILED", SPEC_CONFLICT: "SPEC_CONFLICT", BLOCKED: "BLOCKED", TAMPERED: "TAMPERED", RUNNING: "running" } as const;
export const FILTERABLE_VERDICTS: string[] = [VERDICT.VERIFIED, VERDICT.PARTIAL, VERDICT.FAILED, VERDICT.SPEC_CONFLICT]; // server-side filter values: TAMPERED is derived, not stored

export interface VerdictSource { verdict?: string | null; tampered?: boolean | null; integrity?: string | null; receipt?: { verdict?: string | null } | null }

/** The single place a verdict is derived (Engine Laws L3, L7): any tamper or integrity signal wins over the stored verdict. */
export function effectiveVerdict(r: VerdictSource | null | undefined): string | null {
  if (!r) return null;
  if (r.tampered === true || r.integrity === VERDICT.TAMPERED || r.receipt?.verdict === VERDICT.TAMPERED || r.verdict === VERDICT.TAMPERED) return VERDICT.TAMPERED;
  return r.verdict ?? null;
}
export const isVerified = (r: VerdictSource | null | undefined): boolean => effectiveVerdict(r) === VERDICT.VERIFIED;

export function Badge({ tone = "neutral", pulse, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; pulse?: boolean }) {
  return (
    <span
      {...rest}
      data-cp="badge"
      data-tone={tone}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: t("radius-sm"),
        fontSize: t("text-xs"), textTransform: "uppercase", letterSpacing: "0.025em", fontWeight: 500,
        background: TONE_BG[tone], color: TONE_FG[tone], ...rest.style,
      }}
    >
      {pulse ? <span className="cp-pulse" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} /> : null}
      {children}
    </span>
  );
}

/** Pass `run` to apply the tamper rule; `verdict` alone renders that exact string. */
export function VerdictBadge({ verdict, run }: { verdict?: string | null; run?: VerdictSource | null }) {
  const v = run ? effectiveVerdict(run) : verdict ?? null;
  if (!v) return <Badge pulse>running</Badge>;
  return <Badge tone={VERDICT_TONE[v] ?? "neutral"} pulse={v === VERDICT.RUNNING} data-verdict={v}>{v}</Badge>;
}

/* Pill */
export function Pill({ children, style, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} data-cp="pill" style={{ display: "inline-flex", alignItems: "center", gap: 4, borderRadius: 999, padding: "3px 8px", fontSize: t("text-xs"), background: t("card"), border: `1px solid ${t("border")}`, ...style }}>
      {children}
    </span>
  );
}

/* StatusDot */
export type DotState = "active" | "idle" | "paused" | "error";
const DOT: Record<DotState, string> = { active: t("success-fill"), idle: t("text-muted"), paused: t("warning-fill"), error: t("error-fill") };
export function StatusDot({ state = "idle", label }: { state?: DotState; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label ?? state}
      data-cp="status-dot"
      data-state={state}
      className={state === "active" ? "cp-pulse" : undefined}
      style={{ display: "inline-block", width: 12, height: 6, borderRadius: 2, background: DOT[state] }}
    />
  );
}

/* Button */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<ButtonVariant, CSSProperties> = {
  primary: { background: t("accent-solid"), color: "#ffffff", border: "1px solid transparent" },
  secondary: { background: t("bg-3"), color: t("text"), border: `1px solid ${t("border")}` },
  ghost: { background: "transparent", color: t("text-2"), border: "1px solid transparent" },
  danger: { background: t("error"), color: "#ffffff", border: "1px solid transparent" },
};
export function Button({ variant = "primary", size = "md", style, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" }) {
  const pad = size === "sm" ? "4px 8px" : size === "lg" ? "12px 18px" : "8px 12px";
  return (
    <button
      {...rest}
      type={type}
      data-cp="button"
      data-variant={variant}
      data-size={size}
      style={{ padding: pad, borderRadius: t("radius-md"), fontSize: size === "sm" ? t("text-base") : t("text-md"), fontWeight: 500, cursor: rest.disabled ? "not-allowed" : "pointer", opacity: rest.disabled ? 0.5 : 1, ...BTN[variant], ...style }}
    />
  );
}

/* Input and Textarea */
const FIELD: CSSProperties = { background: t("bg-3"), border: `1px solid ${t("border")}`, borderRadius: t("radius-md"), padding: "8px 12px", fontSize: t("text-md"), color: t("text"), width: "100%", fontFamily: "inherit" };
export function Input({ style, onFocus, onBlur, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [f, setF] = useState(false);
  return (
    <input
      {...rest}
      data-cp="input"
      onFocus={(e) => { setF(true); onFocus?.(e); }}
      onBlur={(e) => { setF(false); onBlur?.(e); }}
      style={{ ...FIELD, ...(f ? { borderColor: t("accent"), boxShadow: t("focus"), outline: "none" } : null), ...style }}
    />
  );
}
export function Textarea({ style, onFocus, onBlur, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [f, setF] = useState(false);
  return (
    <textarea
      {...rest}
      data-cp="textarea"
      onFocus={(e) => { setF(true); onFocus?.(e); }}
      onBlur={(e) => { setF(false); onBlur?.(e); }}
      style={{ ...FIELD, resize: "vertical", ...(f ? { borderColor: t("accent"), boxShadow: t("focus"), outline: "none" } : null), ...style }}
    />
  );
}

/* Chip: a Pill-shaped button with a leading icon and a popover menu */
export function Chip({ label, value, icon, options, onSelect }: {
  label: string; value?: string; icon?: ReactNode; options?: Array<{ value: string; label: string }>; onSelect?: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        data-cp="chip"
        aria-haspopup={options ? "menu" : undefined}
        aria-expanded={options ? open : undefined}
        aria-controls={options && open ? id : undefined}
        onClick={() => options && setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, padding: "4px 10px", fontSize: t("text-base"), background: t("card"), border: `1px solid ${t("border")}`, color: t("text"), cursor: "pointer" }}
      >
        {icon}
        <span style={{ color: t("text-2") }}>{label}</span>
        {value ? <span style={{ fontWeight: 500 }}>{value}</span> : null}
      </button>
      {options && open ? (
        <div id={id} role="menu" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, minWidth: 140, zIndex: 400, background: t("bg"), border: `1px solid ${t("border")}`, borderRadius: t("radius-lg"), boxShadow: t("shadow-lg"), padding: 4 }}>
          {options.map((o) => (
            <button key={o.value} role="menuitem" type="button" onClick={() => { onSelect?.(o.value); setOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", borderRadius: t("radius-md"), background: "transparent", border: 0, color: t("text"), fontSize: t("text-base"), cursor: "pointer" }}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/* Table: wrapper Card, 12px rows, uppercase muted header on bg-3 */
export function Table({ columns, rows, caption }: { columns: string[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <Card style={{ padding: 0, overflow: "auto" }}>
      <table data-cp="table" style={{ width: "100%", borderCollapse: "collapse", fontSize: t("text-base") }}>
        {caption ? <caption style={{ position: "absolute", left: -9999 }}>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" style={{ textAlign: "left", padding: "10px 14px", fontSize: t("text-sm"), fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: t("text-2"), background: t("bg-3") }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${t("border-light")}` }}>
              {r.map((c, j) => <td key={j} style={{ padding: "10px 14px" }}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* NavItem and GroupHead */
export function NavItem({ active, icon, children, href, onClick }: { active?: boolean; icon?: ReactNode; children: ReactNode; href?: string; onClick?: () => void }) {
  const style: CSSProperties = {
    position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: t("radius-nav"), fontSize: t("text-md"), fontWeight: 500,
    textDecoration: "none", cursor: "pointer", border: 0, width: "100%", textAlign: "left",
    background: active ? t("accent-glow") : "transparent", color: active ? t("accent-ink") : t("text-2"),
  };
  const inner = (
    <>
      {active ? <span data-cp="nav-bar" aria-hidden="true" style={{ position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", width: 3, height: 16, borderRadius: 2, background: t("accent") }} /> : null}
      {icon}
      <span>{children}</span>
    </>
  );
  return href
    ? <a data-cp="nav-item" data-active={active ? "true" : undefined} aria-current={active ? "page" : undefined} href={href} onClick={onClick} style={style}>{inner}</a>
    : <button type="button" data-cp="nav-item" data-active={active ? "true" : undefined} aria-current={active ? "page" : undefined} onClick={onClick} style={style}>{inner}</button>;
}

export function GroupHead({ children }: { children: ReactNode }) {
  return <div data-cp="group-head" style={{ fontSize: 9.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.09em", color: t("text-subtle"), padding: "4px 12px 5px" }}>{children}</div>;
}

/* Timeline */
export type TimelineStage = { label: string; status: Tone | "pending"; duration?: string };
export function Timeline({ stages }: { stages: TimelineStage[] }) {
  return (
    <ol data-cp="timeline" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {stages.map((s, i) => (
        <li key={`${s.label}-${i}`} data-status={s.status} style={{ display: "flex", gap: 10, position: "relative", paddingBottom: i === stages.length - 1 ? 0 : 14 }}>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: s.status === "pending" ? t("bg-3") : s.status === "neutral" ? t("text-muted") : t(`${s.status}-fill`), border: `1px solid ${t("border")}` }} />
            {i < stages.length - 1 ? <span style={{ flex: 1, width: 1, background: t("border") }} /> : null}
          </span>
          <span style={{ fontSize: t("text-base") }}>
            {s.label}
            {s.duration ? <span style={{ marginLeft: 8, fontFamily: t("font-mono"), color: t("text-2") }}>{s.duration}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* Message: a thread item with gutter icon, mono meta line and an expandable body */
export function Message({ icon, title, meta, children, expandable, defaultOpen }: {
  icon?: ReactNode; title: ReactNode; meta?: ReactNode; children?: ReactNode; expandable?: boolean; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const id = useId();
  return (
    <div data-cp="message" style={{ display: "flex", gap: 12, padding: "8px 0" }}>
      <span style={{ width: 32, height: 32, borderRadius: 8, flex: "none", background: t("bg-3"), color: t("text-2"), display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: t("text-md") }}>{title}</div>
        {meta ? <div style={{ fontFamily: t("font-mono"), fontSize: t("text-sm"), color: t("text-2") }}>{meta}</div> : null}
        {expandable ? (
          <>
            <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} style={{ background: "transparent", border: 0, padding: 0, marginTop: 4, color: t("accent"), fontSize: t("text-base"), cursor: "pointer" }}>
              {open ? "Hide details" : "Show details"}
            </button>
            {open ? <Card id={id} style={{ marginTop: 6 }}>{children}</Card> : null}
          </>
        ) : children}
      </div>
    </div>
  );
}

/* EmptyState and Spinner */
export function EmptyState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div data-cp="empty-state" style={{ textAlign: "center", padding: "var(--cp-space-3xl) var(--cp-space-xl)", color: t("text-2") }}>
      <div style={{ fontFamily: t("font-serif"), fontSize: t("text-2xl"), color: t("text") }}>{title}</div>
      {hint ? <div style={{ marginTop: 8, fontSize: t("text-md") }}>{hint}</div> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 16, label = "Loading" }: { size?: number; label?: string }) {
  return (
    <span role="status" aria-label={label} data-cp="spinner" className="cp-spinner" style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", border: `2px solid ${t("border")}`, borderTopColor: t("accent") }} />
  );
}

/* Toast */
export function Toast({ tone = "neutral", children, onClose }: { tone?: Tone; children: ReactNode; onClose?: () => void }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} data-cp="toast" data-tone={tone} style={{ position: "fixed", right: 16, bottom: 16, zIndex: 600, display: "flex", gap: 12, alignItems: "center", background: t("bg"), border: `1px solid ${t("border")}`, borderLeft: `3px solid ${TONE_FG[tone]}`, borderRadius: t("radius-lg"), boxShadow: t("shadow-lg"), padding: "10px 14px", fontSize: t("text-md"), color: t("text") }}>
      <span>{children}</span>
      {onClose ? <button type="button" aria-label="Dismiss" onClick={onClose} style={{ background: "transparent", border: 0, color: t("text-2"), cursor: "pointer" }}>x</button> : null}
    </div>
  );
}

/* Dialog and Drawer share one overlay with Escape to close and focus restore */
function useOverlay(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus?.(); };
  }, [open, onClose]);
  return ref;
}

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children?: ReactNode }) {
  const ref = useOverlay(open, onClose);
  const tid = useId();
  if (!open) return null;
  return (
    <div data-cp="dialog-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={tid} tabIndex={-1} data-cp="dialog" onClick={(e) => e.stopPropagation()} style={{ width: "min(480px, 92vw)", background: t("bg"), color: t("text"), border: `1px solid ${t("border")}`, borderRadius: t("radius-lg"), boxShadow: t("shadow-lg"), padding: 20 }}>
        <h2 id={tid} style={{ margin: "0 0 12px", fontFamily: t("font-serif"), fontWeight: 400, fontSize: "1.15rem" }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ open, title, onClose, side = "right", children }: { open: boolean; title: string; onClose: () => void; side?: "left" | "right"; children?: ReactNode }) {
  const ref = useOverlay(open, onClose);
  const tid = useId();
  if (!open) return null;
  return (
    <div data-cp="drawer-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.3)" }}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={tid} tabIndex={-1} data-cp="drawer" data-side={side} onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, bottom: 0, [side]: 0, width: "min(var(--cp-detail-w, 288px), 92vw)", background: t("bg"), color: t("text"), borderLeft: side === "right" ? `1px solid ${t("border")}` : undefined, borderRight: side === "left" ? `1px solid ${t("border")}` : undefined, boxShadow: t("shadow-lg"), padding: 16, overflow: "auto" }}>
        <h2 id={tid} style={{ margin: "0 0 12px", fontFamily: t("font-serif"), fontWeight: 400, fontSize: "1.15rem" }}>{title}</h2>
        {children}
      </aside>
    </div>
  );
}

/* Kbd */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd data-cp="kbd" style={{ fontFamily: t("font-mono"), fontSize: t("text-sm"), padding: "1px 5px", borderRadius: t("radius-md"), background: t("bg-3"), border: `1px solid ${t("border")}`, color: t("text-2") }}>{children}</kbd>;
}
