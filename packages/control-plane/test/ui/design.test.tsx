import "./dom";
// CPE-01 Wall check: every spec 2.1 token is present in both themes, hex values match the cited legacy sources,
// text tokens meet contrast, and every primitive renders.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const P = await import("../../ui/src/design/primitives");
const preset = (await import("../../ui/src/design/tailwind.preset")).default;

afterEach(cleanup);

const DESIGN = join(import.meta.dir, "../../ui/src/design");
const REPO = join(import.meta.dir, "../../../..");
const css = readFileSync(join(DESIGN, "tokens.css"), "utf8");
const spec = readFileSync(join(REPO, "docs/v10/CP-ENTERPRISE-UI.md"), "utf8");

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--cp-[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim().replace(/\s*\/\*.*$/, "");
  return out;
}
function blockAfter(selector: string, src: string): string {
  const i = src.indexOf(selector);
  expect(i).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    if (src[j] === "}" && --depth === 0) return src.slice(open + 1, j);
  }
  throw new Error("unbalanced " + selector);
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const specCss = stripComments(spec.slice(spec.indexOf("### 2.1"), spec.indexOf("### 2.2")));
const specLight = vars(blockAfter(':root, [data-theme="light"]', specCss));
const specDark = vars(blockAfter('[data-theme="dark"] {', specCss));
const tokCss = stripComments(css);
const light = vars(blockAfter(':root, [data-theme="light"]', tokCss));
const dark = vars(blockAfter('[data-theme="dark"] {', tokCss));
const rootVars = vars(blockAfter("\n:root {", tokCss));
const mediaDark = vars(blockAfter(':root:not([data-theme="light"])', tokCss));

test("every spec 2.1 token is present in both themes with the spec value", () => {
  expect(Object.keys(specLight).length).toBeGreaterThan(35);
  expect(Object.keys(specDark).length).toBeGreaterThan(30);
  for (const [k, v] of Object.entries(specLight)) expect(light[k], `light ${k}`).toBe(v);
  for (const [k, v] of Object.entries(specDark)) expect(dark[k], `dark ${k}`).toBe(v);
  // themed (color/shadow) tokens exist in BOTH themes; the prefers-color-scheme block mirrors dark
  const themed = Object.keys(specDark);
  for (const k of themed) expect(light[k], `light has ${k}`).toBeDefined();
  expect(mediaDark).toEqual(dark);
  // the non-themed tokens live on :root
  for (const k of ["--cp-font-serif", "--cp-font-sans", "--cp-font-mono", "--cp-text-md", "--cp-space-lg", "--cp-radius-lg", "--cp-radius-nav", "--cp-ease", "--cp-sidebar-w", "--cp-thread-max", "--cp-z-toast"]) {
    expect(rootVars[k], k).toBeDefined();
  }
});

test("the spec carries a full hex palette", () => {
  const hexes = new Set([...Object.values(specLight), ...Object.values(specDark)].flatMap((v) => v.match(/#[0-9a-fA-F]{6}\b/g) ?? []));
  expect(hexes.size).toBeGreaterThan(30);
  expect(light["--cp-bg"]).toBe("#F1F2F6");
  expect(light["--cp-accent"]).toBe("#553DE9");
  expect(dark["--cp-bg"]).toBe("#17161C");
});

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

test("text tokens meet WCAG AA on the ground and on opaque surfaces", () => {
  // The legacy light success, warning and info fills and text-muted are 3.2 to 4.2:1 on the light ground, so primitives
  // use the AA companions (-ink, text-subtle); the legacy hex stay for fills, icons and large text (checked below).
  for (const [name, th] of [["light", light], ["dark", dark]] as const) {
    for (const fg of ["--cp-text", "--cp-text-2", "--cp-accent", "--cp-success-ink", "--cp-warning-ink", "--cp-error", "--cp-info-ink", "--cp-text-subtle"]) {
      for (const bg of ["--cp-bg", "--cp-bg-2"]) {
        expect(ratio(th[fg]!, th[bg]!), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(ratio(th["--cp-text-inverse"]!, th["--cp-text"]!), `${name} inverse`).toBeGreaterThanOrEqual(4.5);
  }
  // white label on the primary button fill (light accent) and on danger
  expect(ratio("#ffffff", light["--cp-accent"]!)).toBeGreaterThanOrEqual(4.5);
  expect(ratio("#ffffff", light["--cp-error"]!)).toBeGreaterThanOrEqual(4.5);
});

test("legacy muted and status hex keep the 3:1 non-text and large-text bound on the ground", () => {
  for (const [th, bg] of [[light, "--cp-bg"], [dark, "--cp-bg"]] as const) {
    for (const fg of ["--cp-text-muted", "--cp-success", "--cp-warning", "--cp-error", "--cp-info"]) {
      expect(ratio(th[fg]!, th[bg]!), fg).toBeGreaterThanOrEqual(3);
    }
  }
});

test("tailwind preset maps colors, radius and fonts to the vars", () => {
  const e = preset.theme.extend;
  expect(e.colors.bg).toBe("var(--cp-bg)");
  expect(e.colors.accent).toBe("var(--cp-accent)");
  expect(e.borderRadius.lg).toBe("var(--cp-radius-lg)");
  expect(e.fontFamily.serif[0]).toBe("var(--cp-font-serif)");
  for (const v of Object.values(e.colors)) expect({ ...rootVars, ...light }[String(v).slice(4, -1)], String(v)).toBeDefined();
});

test("fonts.css requests the three families", () => {
  const f = readFileSync(join(DESIGN, "fonts.css"), "utf8");
  for (const fam of ["Fraunces", "Inter", "JetBrains+Mono"]) expect(f).toContain(fam);
});

test("tokens and primitives contain no emoji or dash punctuation", () => {
  for (const f of ["tokens.css", "fonts.css", "tailwind.preset.ts", "primitives/index.tsx"]) {
    expect(/[–—\u{1F300}-\u{1FAFF}☀-➿]/u.test(readFileSync(join(DESIGN, f), "utf8")), f).toBe(false);
  }
});

test("Card, KpiTile, Badge, Pill, StatusDot render", () => {
  const { container } = render(
    <div>
      <P.Card interactive>card body</P.Card>
      <P.KpiTile label="Cost" value="$1.20" trend="+3%" trendTone="success" series={[1, 3, 2, 5]} />
      <P.KpiTile label="Runs" value="4" compact />
      <P.Badge tone="success">ok</P.Badge>
      <P.VerdictBadge verdict="SPEC_CONFLICT" />
      <P.VerdictBadge verdict="running" />
      <P.Pill>receipts</P.Pill>
      <P.StatusDot state="active" />
    </div>,
  );
  expect(screen.getByText("card body")).toBeDefined();
  expect(screen.getByText("$1.20").style.fontFamily).toContain("font-mono");
  expect(container.querySelectorAll('[data-cp="sparkline"]').length).toBe(1);
  expect(container.querySelector('[data-cp="badge"][data-tone="info"]')?.textContent).toBe("SPEC_CONFLICT");
  expect(container.querySelector('[data-cp="badge"][data-tone="neutral"] .cp-pulse')).not.toBeNull();
  expect(screen.getByLabelText("active").getAttribute("data-state")).toBe("active");
});

test("Button, Input, Chip behave", () => {
  let picked = "";
  let clicks = 0;
  render(
    <div>
      <P.Button onClick={() => clicks++}>Go</P.Button>
      <P.Button variant="danger" disabled>Stop</P.Button>
      <P.Input aria-label="task" />
      <P.Chip label="Model" value="sonnet" options={[{ value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }]} onSelect={(v) => { picked = v; }} />
    </div>,
  );
  fireEvent.click(screen.getByText("Go"));
  expect(clicks).toBe(1);
  expect((screen.getByText("Stop") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Stop").style.opacity).toBe("0.5");
  fireEvent.focus(screen.getByLabelText("task"));
  expect((screen.getByLabelText("task") as HTMLInputElement).style.boxShadow).toContain("--cp-focus");
  fireEvent.click(screen.getByText("Model").closest("button")!);
  fireEvent.click(screen.getByText("Opus"));
  expect(picked).toBe("opus");
});

test("Table, NavItem, GroupHead, Timeline, Message render", () => {
  const { container } = render(
    <div>
      <P.Table columns={["Run", "Verdict"]} rows={[["r1", "VERIFIED"], ["r2", "FAILED"]]} />
      <P.GroupHead>Today</P.GroupHead>
      <P.NavItem active href="#/runs">Runs</P.NavItem>
      <P.NavItem>Cost</P.NavItem>
      <P.Timeline stages={[{ label: "Plan", status: "success", duration: "4s" }, { label: "Build", status: "neutral" }, { label: "Verify", status: "pending" }]} />
      <P.Message title="Edited file" meta="seq 12" expandable>diff body</P.Message>
    </div>,
  );
  expect(container.querySelectorAll("tbody tr").length).toBe(2);
  expect(container.querySelectorAll("th").length).toBe(2);
  expect(screen.getByText("Today").textContent).toBe("Today");
  expect(container.querySelector('[data-cp="nav-item"][aria-current="page"]')?.getAttribute("href")).toBe("#/runs");
  expect(container.querySelectorAll('[data-cp="nav-bar"]').length).toBe(1);
  expect(container.querySelectorAll('[data-cp="timeline"] li').length).toBe(3);
  expect(screen.queryByText("diff body")).toBeNull();
  fireEvent.click(screen.getByText("Show details"));
  expect(screen.getByText("diff body")).toBeDefined();
});

test("EmptyState, Spinner, Toast, Kbd render", () => {
  let closed = 0;
  render(
    <div>
      <P.EmptyState title="No runs yet" hint="Run loki start" action={<P.Button>Import</P.Button>} />
      <P.Spinner />
      <P.Toast tone="error" onClose={() => closed++}>Failed</P.Toast>
      <P.Kbd>Ctrl K</P.Kbd>
    </div>,
  );
  expect(screen.getByText("No runs yet")).toBeDefined();
  expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("Failed");
  fireEvent.click(screen.getByLabelText("Dismiss"));
  expect(closed).toBe(1);
  expect(screen.getByText("Ctrl K").tagName).toBe("KBD");
});

test("Dialog and Drawer open, close on Escape, and are closed by default", () => {
  let closed = 0;
  const { rerender } = render(<P.Dialog open={false} title="Confirm" onClose={() => closed++}>sure?</P.Dialog>);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<P.Dialog open title="Confirm" onClose={() => closed++}>sure?</P.Dialog>);
  expect(screen.getByRole("dialog", { name: "Confirm" })).toBeDefined();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(closed).toBe(1);
  rerender(<P.Drawer open title="Details" onClose={() => closed++}>panel</P.Drawer>);
  expect(screen.getByRole("dialog", { name: "Details" }).getAttribute("data-side")).toBe("right");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(closed).toBe(2);
});
