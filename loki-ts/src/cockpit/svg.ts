// State -> self-contained SVG builder for the `loki cockpit` frame.
//
// Renders the approved Autonomi cockpit: a header with the real Autonomi mark
// (purple squircle + white "A" + teal dot), a primary run panel (iteration /
// phase / tier / provider / verdict / budget / freshness), a gate strip, a
// council-vote strip, and a compact multi-repo fleet list.
//
// The SVG is fully self-contained (no external fonts/images): the logo is
// inline vector, fonts fall back through the system stack, all colors are the
// verified Autonomi palette. Text is XML-escaped so arbitrary run/repo names
// cannot break the markup.

export type Verdict = "verified" | "working" | "failed" | "pending" | "unknown";
export type GateStatus = "pass" | "fail" | "skip" | "pending";
export type CouncilVote = "approve" | "concern" | "reject" | "pending";

export interface Gate {
  name: string;
  status: GateStatus;
  runner?: string; // tool that produced the gate (tsc, jest, npm-audit, ...)
  evidence?: string; // one-line summary from evidence.json
}

export interface Council {
  reviewer: string;
  vote: CouncilVote;
  tier?: string; // model tier: opus | sonnet | haiku
}

export interface RepoRun {
  name: string;
  phase?: string;
  iteration?: number;
  status?: string; // running | stopped | ...
  running?: boolean;
}

export interface CockpitState {
  run: string; // focused run / project name
  iteration: number;
  phase: string;
  tier: string; // opus | sonnet | haiku
  provider: string; // claude | opencode
  verdict: Verdict;
  budgetUsd: number;
  budgetLimitUsd?: number;
  freshness?: string; // e.g. "fresh", "3m ago"
  gates: Gate[];
  council: Council[];
  fleet: RepoRun[];
}

// ---- Autonomi identity (verified against ~/git/autonomi-website) ----------
const ACCENT = "#553de9"; // brand purple (light)
const TEAL = "#1FC5A8"; // teal dot
const INK = "#201515";
const GROUND = "#f1f2f6"; // light-grey ground (default)
const CARD = "#ffffff";
const MUTED = "#6b6675";
const HAIRLINE = "#e2e0e8";
const VERIFIED = "#1f8a52";
const WARNING = "#9a6a12";
const FAILED = "#b23a3a";
const WHITE_A = "#FFFEFB";

const FONT_DISPLAY = "'Fraunces','Georgia',serif";
const FONT_BODY = "'Inter','Helvetica Neue',Arial,sans-serif";
const FONT_MONO = "'JetBrains Mono','SF Mono',ui-monospace,monospace";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The Autonomi mark, drawn at a given top-left with a given size (px). Uses the
// verified 512-viewBox geometry scaled to `size`. Renders as its own <g>.
function logoMark(x: number, y: number, size: number): string {
  const s = size / 512;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <rect x="0" y="0" width="512" height="512" rx="118" fill="${ACCENT}"/>
    <path d="M152 405 L242 120" stroke="${WHITE_A}" stroke-width="28" stroke-linecap="round" fill="none"/>
    <path d="M360 405 L270 120" stroke="${WHITE_A}" stroke-width="28" stroke-linecap="round" fill="none"/>
    <path d="M242 120 Q256 86 270 120" stroke="${WHITE_A}" stroke-width="28" stroke-linecap="round" fill="none"/>
    <circle cx="256" cy="295" r="20" fill="${TEAL}"/>
  </g>`;
}

function verdictColor(v: Verdict): string {
  switch (v) {
    case "verified":
      return VERIFIED;
    case "failed":
      return FAILED;
    case "working":
    case "pending":
      return WARNING;
    default:
      return MUTED;
  }
}

function gateColor(s: GateStatus): string {
  switch (s) {
    case "pass":
      return VERIFIED;
    case "fail":
      return FAILED;
    case "pending":
      return WARNING;
    default:
      return MUTED; // skip
  }
}

function voteColor(v: CouncilVote): string {
  switch (v) {
    case "approve":
      return VERIFIED;
    case "reject":
      return FAILED;
    case "concern":
      return WARNING;
    default:
      return MUTED;
  }
}

// A small labeled stat block.
function statBlock(x: number, y: number, label: string, value: string, valueColor = INK): string {
  return `<text x="${x}" y="${y}" font-family="${FONT_BODY}" font-size="12" fill="${MUTED}" letter-spacing="0.5">${esc(label.toUpperCase())}</text>
    <text x="${x}" y="${y + 24}" font-family="${FONT_MONO}" font-size="20" font-weight="600" fill="${valueColor}">${esc(value)}</text>`;
}

// The RARV loop: Reason -> Act -> Reflect -> Verify. The current step is derived
// from the free-form phase string; earlier steps read as done, later as pending.
const RARV_STEPS = ["Reason", "Act", "Reflect", "Verify"] as const;

// Map a free-form phase to a RARV index (0..3). Best-effort keyword match; an
// unrecognized phase lands on Act (the default working step) rather than lying.
function rarvIndex(phase: string): number {
  const p = (phase || "").toLowerCase();
  if (/verif|complet|done|ship|deploy/.test(p)) return 3;
  if (/reflect|review|council|critique|assess/.test(p)) return 2;
  if (/reason|plan|design|architect|spec|analy/.test(p)) return 0;
  return 1; // act / implement / build / test / everything else
}

export function buildSvg(raw: CockpitState): string {
  const W = 900;
  const PAD = 32;

  // Normalize the state once with safe defaults so a malformed/partial state
  // (missing verdict, budget, gates, ...) DEGRADES gracefully and always renders
  // a frame, rather than crashing the whole render. The real gather path always
  // supplies these, but a hand-written or truncated state must not take it down.
  const state: CockpitState = {
    run: raw?.run || "cockpit",
    iteration: typeof raw?.iteration === "number" ? raw.iteration : 0,
    phase: raw?.phase || "idle",
    tier: raw?.tier || "",
    provider: raw?.provider || "",
    verdict: raw?.verdict || "unknown",
    budgetUsd: typeof raw?.budgetUsd === "number" ? raw.budgetUsd : 0,
    budgetLimitUsd: raw?.budgetLimitUsd,
    freshness: raw?.freshness,
    gates: Array.isArray(raw?.gates) ? raw.gates : [],
    council: Array.isArray(raw?.council) ? raw.council : [],
    fleet: Array.isArray(raw?.fleet) ? raw.fleet : [],
  };

  const budgetStr =
    state.budgetLimitUsd && state.budgetLimitUsd > 0
      ? `$${state.budgetUsd.toFixed(2)} / $${state.budgetLimitUsd.toFixed(2)}`
      : `$${state.budgetUsd.toFixed(2)}`;

  // Header
  let body = "";
  body += logoMark(PAD, PAD, 44);
  body += `<text x="${PAD + 60}" y="${PAD + 22}" font-family="${FONT_DISPLAY}" font-size="24" font-weight="600" fill="${INK}">Autonomi</text>`;
  body += `<text x="${PAD + 60}" y="${PAD + 42}" font-family="${FONT_BODY}" font-size="13" fill="${MUTED}">Loki Cockpit</text>`;
  const fresh = state.freshness ? `updated ${state.freshness}` : "live";
  body += `<text x="${W - PAD}" y="${PAD + 22}" text-anchor="end" font-family="${FONT_MONO}" font-size="12" fill="${MUTED}">${esc(fresh)}</text>`;
  body += `<text x="${W - PAD}" y="${PAD + 42}" text-anchor="end" font-family="${FONT_MONO}" font-size="13" fill="${verdictColor(state.verdict)}" font-weight="600">${esc(state.verdict.toUpperCase())}</text>`;

  // Primary run card
  const cardY = PAD + 64;
  const cardH = 168;
  body += `<rect x="${PAD}" y="${cardY}" width="${W - 2 * PAD}" height="${cardH}" rx="16" fill="${CARD}" stroke="${HAIRLINE}"/>`;
  body += `<text x="${PAD + 24}" y="${cardY + 34}" font-family="${FONT_DISPLAY}" font-size="20" font-weight="600" fill="${INK}">${esc(state.run)}</text>`;
  body += `<text x="${PAD + 24}" y="${cardY + 54}" font-family="${FONT_BODY}" font-size="13" fill="${MUTED}">phase ${esc(state.phase)}</text>`;

  const row1 = cardY + 96;
  const col = (n: number) => PAD + 24 + n * 168;
  body += statBlock(col(0), row1, "iteration", String(state.iteration));
  body += statBlock(col(1), row1, "tier", state.tier);
  body += statBlock(col(2), row1, "provider", state.provider);
  body += statBlock(col(3), row1, "budget", budgetStr);
  // phase is shown in the card subtitle + the RARV strip below, so no 5th
  // stat block here (it collided with budget and duplicated the phase).

  // RARV loop (Reason -> Act -> Reflect -> Verify), current step from phase.
  const rarvY = cardY + cardH + 40;
  body += `<text x="${PAD}" y="${rarvY}" font-family="${FONT_BODY}" font-size="13" font-weight="600" fill="${MUTED}" letter-spacing="0.5">RARV LOOP</text>`;
  const now = rarvIndex(state.phase);
  const rsy = rarvY + 14;
  const stepW = (W - 2 * PAD - 3 * 12) / 4;
  RARV_STEPS.forEach((label, i) => {
    const sx = PAD + i * (stepW + 12);
    const done = i < now;
    const active = i === now;
    const c = active ? ACCENT : done ? VERIFIED : MUTED;
    const fill = active ? ACCENT : CARD;
    const fillOp = active ? "0.10" : "1";
    body += `<rect x="${sx}" y="${rsy}" width="${stepW}" height="40" rx="10" fill="${fill}" fill-opacity="${fillOp}" stroke="${c}" stroke-width="${active ? 2 : 1}"/>`;
    const glyph = done ? "check" : active ? "dot" : "wait";
    if (glyph === "check") {
      body += `<path d="M${sx + 16} ${rsy + 20} l6 6 l10 -12" stroke="${VERIFIED}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (glyph === "dot") {
      body += `<circle cx="${sx + 22}" cy="${rsy + 20}" r="5" fill="${ACCENT}"/>`;
    } else {
      body += `<circle cx="${sx + 22}" cy="${rsy + 20}" r="5" fill="none" stroke="${MUTED}" stroke-width="1.5"/>`;
    }
    body += `<text x="${sx + 40}" y="${rsy + 25}" font-family="${FONT_BODY}" font-size="14" font-weight="${active ? 600 : 500}" fill="${active ? ACCENT : done ? INK : MUTED}">${label}</text>`;
  });

  // Gate rows (verify --explain: gate / status / runner / evidence)
  const gateY = rsy + 40 + 40;
  body += `<text x="${PAD}" y="${gateY}" font-family="${FONT_BODY}" font-size="13" font-weight="600" fill="${MUTED}" letter-spacing="0.5">QUALITY GATES</text>`;
  const gates = state.gates.length ? state.gates : [{ name: "no gates yet", status: "pending" as GateStatus }];
  const rowH = 30;
  let gsy = gateY + 12;
  body += `<rect x="${PAD}" y="${gsy}" width="${W - 2 * PAD}" height="${gates.slice(0, 8).length * rowH + 8}" rx="12" fill="${CARD}" stroke="${HAIRLINE}"/>`;
  gsy += 8;
  for (const g of gates.slice(0, 8)) {
    const c = gateColor(g.status);
    const cy = gsy + rowH / 2;
    body += `<circle cx="${PAD + 18}" cy="${cy}" r="4" fill="${c}"/>`;
    body += `<text x="${PAD + 34}" y="${cy + 4}" font-family="${FONT_MONO}" font-size="12" fill="${INK}">${esc(g.name)}</text>`;
    if (g.runner) {
      body += `<text x="${PAD + 210}" y="${cy + 4}" font-family="${FONT_BODY}" font-size="11" fill="${MUTED}">${esc(g.runner)}</text>`;
    }
    if (g.evidence) {
      const ev = g.evidence.length > 52 ? `${g.evidence.slice(0, 49)}...` : g.evidence;
      body += `<text x="${PAD + 300}" y="${cy + 4}" font-family="${FONT_BODY}" font-size="11" fill="${MUTED}">${esc(ev)}</text>`;
    }
    body += `<text x="${W - PAD - 16}" y="${cy + 4}" text-anchor="end" font-family="${FONT_MONO}" font-size="11" font-weight="700" fill="${c}">${esc(g.status.toUpperCase())}</text>`;
    gsy += rowH;
  }

  // Council: one row per reviewer (name + model tier + vote)
  const councilY = gsy + 40;
  body += `<text x="${PAD}" y="${councilY}" font-family="${FONT_BODY}" font-size="13" font-weight="600" fill="${MUTED}" letter-spacing="0.5">COMPLETION COUNCIL</text>`;
  const council = state.council.length ? state.council : [{ reviewer: "pending", vote: "pending" as CouncilVote }];
  let csy = councilY + 12;
  body += `<rect x="${PAD}" y="${csy}" width="${W - 2 * PAD}" height="${council.slice(0, 6).length * rowH + 8}" rx="12" fill="${CARD}" stroke="${HAIRLINE}"/>`;
  csy += 8;
  for (const cv of council.slice(0, 6)) {
    const c = voteColor(cv.vote);
    const cy = csy + rowH / 2;
    body += `<circle cx="${PAD + 18}" cy="${cy}" r="4" fill="${c}"/>`;
    body += `<text x="${PAD + 34}" y="${cy + 4}" font-family="${FONT_BODY}" font-size="12.5" font-weight="500" fill="${INK}">${esc(cv.reviewer)}</text>`;
    if (cv.tier) {
      body += `<text x="${PAD + 260}" y="${cy + 4}" font-family="${FONT_MONO}" font-size="11" fill="${MUTED}">${esc(cv.tier)}</text>`;
    }
    body += `<text x="${W - PAD - 16}" y="${cy + 4}" text-anchor="end" font-family="${FONT_MONO}" font-size="11" font-weight="700" fill="${c}">${esc(cv.vote.toUpperCase())}</text>`;
    csy += rowH;
  }

  // Fleet list. Header shows active vs total so a long tail of finished/stale
  // runs reads honestly rather than as an alarming bare count.
  const fleetY = csy + 46;
  const fleetActive = state.fleet.filter((r) => r.running).length;
  const fleetHdr =
    fleetActive > 0
      ? `FLEET (${fleetActive} active / ${state.fleet.length})`
      : `FLEET (${state.fleet.length}, none active)`;
  body += `<text x="${PAD}" y="${fleetY}" font-family="${FONT_BODY}" font-size="13" font-weight="600" fill="${MUTED}" letter-spacing="0.5">${fleetHdr}</text>`;
  let fy = fleetY + 20;
  const shown = state.fleet.slice(0, 4);
  for (const r of shown) {
    const dot = r.running ? VERIFIED : MUTED;
    body += `<circle cx="${PAD + 6}" cy="${fy - 4}" r="5" fill="${dot}"/>`;
    body += `<text x="${PAD + 20}" y="${fy}" font-family="${FONT_MONO}" font-size="13" fill="${INK}">${esc(r.name)}</text>`;
    const meta = `iter ${r.iteration ?? 0}  ${esc(r.phase || r.status || "")}`;
    body += `<text x="${W - PAD}" y="${fy}" text-anchor="end" font-family="${FONT_MONO}" font-size="12" fill="${MUTED}">${meta}</text>`;
    fy += 26;
  }
  if (state.fleet.length > shown.length) {
    body += `<text x="${PAD + 20}" y="${fy}" font-family="${FONT_BODY}" font-size="12" fill="${MUTED}">+ ${state.fleet.length - shown.length} more</text>`;
    fy += 26;
  }

  const H = Math.round(fy + PAD); // grow to fit content, never clip a section

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${GROUND}"/>
  ${body}
</svg>`;
}
