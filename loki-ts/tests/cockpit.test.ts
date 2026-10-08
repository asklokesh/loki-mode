import { beforeAll, describe, expect, it } from "bun:test";
import { detectProtocol } from "../src/cockpit/capability.ts";
import { encodeIterm2, encodeKitty } from "../src/cockpit/encode.ts";
import { buildSvg, type CockpitState } from "../src/cockpit/svg.ts";
import { render } from "../src/cockpit/render.ts";

const ESC = "\x1b";
const BEL = "\x07";

// A tiny valid-ish PNG byte blob (content does not matter for encoding shape).
const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

const SAMPLE: CockpitState = {
  run: "autonomi-saas",
  iteration: 7,
  phase: "implementation",
  tier: "opus",
  provider: "claude",
  verdict: "working",
  budgetUsd: 3.42,
  budgetLimitUsd: 20,
  freshness: "3s ago",
  gates: [
    { name: "build", status: "pass", runner: "vite", evidence: "built in 4.2s" },
    { name: "tests", status: "fail", runner: "jest", evidence: "tests failed (rc=1)" },
    { name: "static_analysis", status: "pass", runner: "tsc", evidence: "no errors" },
  ],
  council: [
    { reviewer: "architecture-strategist", vote: "approve", tier: "opus" },
    { reviewer: "security-sentinel", vote: "concern", tier: "opus" },
    { reviewer: "test-coverage-auditor", vote: "pending", tier: "sonnet" },
  ],
  fleet: [
    { name: "autonomi-saas", phase: "impl", iteration: 7, running: true },
    { name: "loki-mode", phase: "review", iteration: 12, running: false },
  ],
};

describe("cockpit encode", () => {
  it("iTerm2 sequence has the right byte shape", () => {
    const out = encodeIterm2(TINY_PNG);
    expect(out.startsWith(`${ESC}]1337;File=inline=1`)).toBe(true);
    expect(out).toContain(`size=${TINY_PNG.length}`);
    expect(out).toContain("width=auto");
    expect(out).toContain(":"); // separator before base64
    expect(out.endsWith(BEL)).toBe(true);
    // base64 payload present
    expect(out).toContain(Buffer.from(TINY_PNG).toString("base64"));
  });

  it("iTerm2 scales to terminal columns when given a width (fills the pane)", () => {
    const out = encodeIterm2(TINY_PNG, 120);
    // width in cells, not native size, so the cockpit fills 120 columns.
    expect(out).toContain("width=120");
    expect(out).not.toContain("width=auto");
    expect(out).toContain("height=auto"); // aspect preserved
  });

  it("Kitty scales via c=<cols> when given a width", () => {
    const out = encodeKitty(TINY_PNG, 4096, 120);
    expect(out).toContain("c=120");
  });

  it("Kitty sequence has the right byte shape", () => {
    const out = encodeKitty(TINY_PNG);
    expect(out.startsWith(`${ESC}_G`)).toBe(true);
    expect(out).toContain("a=T,f=100");
    expect(out.endsWith(`${ESC}\\`)).toBe(true);
    expect(out).toContain(Buffer.from(TINY_PNG).toString("base64"));
  });

  it("Kitty chunks large payloads with m=1 continuations and m=0 terminator", () => {
    const big = new Uint8Array(9000).fill(65);
    const out = encodeKitty(big, 4096);
    // first chunk declares the transfer and is "more"
    expect(out).toContain("a=T,f=100,m=1");
    // last chunk closes it
    expect(out).toContain("m=0");
    // multiple APC blocks
    const blocks = out.split(`${ESC}_G`).length - 1;
    expect(blocks).toBeGreaterThan(1);
  });
});

describe("cockpit capability detection", () => {
  it("iTerm.app -> iterm2", () => {
    expect(detectProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
  });
  it("WezTerm and ghostty -> iterm2", () => {
    expect(detectProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("iterm2");
    expect(detectProtocol({ TERM_PROGRAM: "ghostty" })).toBe("iterm2");
  });
  it("KITTY_WINDOW_ID set -> kitty", () => {
    expect(detectProtocol({ KITTY_WINDOW_ID: "3" })).toBe("kitty");
  });
  it("TERM=xterm-kitty -> kitty", () => {
    expect(detectProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
  });
  it("TERM=dumb / unset -> none", () => {
    expect(detectProtocol({ TERM: "dumb" })).toBe("none");
    expect(detectProtocol({})).toBe("none");
  });
  it("LOKI_COCKPIT_PROTOCOL override wins over sniffing", () => {
    expect(detectProtocol({ TERM_PROGRAM: "iTerm.app", LOKI_COCKPIT_PROTOCOL: "kitty" })).toBe("kitty");
    expect(detectProtocol({ KITTY_WINDOW_ID: "3", LOKI_COCKPIT_PROTOCOL: "none" })).toBe("none");
  });
});

describe("cockpit SVG builder", () => {
  it("returns well-formed SVG with Autonomi identity and content", () => {
    const svg = buildSvg(SAMPLE);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    // exact Autonomi palette
    expect(svg).toContain("#553de9"); // accent
    expect(svg).toContain("#1FC5A8"); // teal dot
    // logo geometry present (the "A" strokes + squircle)
    expect(svg).toContain("M152 405");
    expect(svg).toContain('rx="118"');
    // run content present
    expect(svg).toContain("autonomi-saas");
    expect(svg).toContain("ITERATION");
    // fleet + council text present
    expect(svg).toContain("loki-mode");
    expect(svg).toContain("architecture-strategist");
  });

  it("renders the RARV loop with the current step from phase", () => {
    const svg = buildSvg(SAMPLE);
    expect(svg).toContain("RARV LOOP");
    for (const step of ["Reason", "Act", "Reflect", "Verify"]) {
      expect(svg).toContain(`>${step}</text>`);
    }
  });

  it("maps the ACTIVE RARV step to the phase (fail-when-broken, not a tautology)", () => {
    // The active step's label is the ONLY one rendered with the accent fill
    // (#553de9) at weight 600 -- extract it and assert it tracks the phase.
    // A mutation that mis-maps the phase moves this label and fails the test.
    const activeStep = (phase: string): string | null => {
      const svg = buildSvg({ ...SAMPLE, phase });
      // <text ... font-weight="600" fill="#553de9" ...>Label</text>
      const re = /font-weight="600"\s+fill="#553de9"[^>]*>(Reason|Act|Reflect|Verify)<\/text>/g;
      const hits: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(svg)) !== null) hits.push(m[1]!);
      return hits.length === 1 ? hits[0]! : null;
    };
    expect(activeStep("reasoning")).toBe("Reason");
    expect(activeStep("implementation")).toBe("Act");
    expect(activeStep("reflecting")).toBe("Reflect");
    expect(activeStep("verifying")).toBe("Verify");
    // Unknown phase must never lie -- it lands on Act, not a fabricated step.
    expect(activeStep("totally-unknown-phase")).toBe("Act");
  });

  it("auto-fits SVG height to content so no section clips (fail-when-broken)", () => {
    const heightOf = (svg: string): number => {
      const m = svg.match(/<svg[^>]*\bheight="(\d+)"/);
      return m ? Number(m[1]) : 0;
    };
    // A rich state (many gates + full council + multi-repo fleet) must produce a
    // TALLER canvas than a sparse one; a fixed height would clip the lower
    // sections. Reverting the auto-fit to a constant fails this.
    const rich = heightOf(buildSvg(SAMPLE));
    const sparse = heightOf(
      buildSvg({ ...SAMPLE, gates: [], council: [], fleet: [] }),
    );
    expect(rich).toBeGreaterThan(560); // old clipping constant
    expect(rich).toBeGreaterThan(sparse); // grows with content
  });

  it("renders per-reviewer council votes with real names and model tiers", () => {
    const svg = buildSvg(SAMPLE);
    expect(svg).toContain("COMPLETION COUNCIL");
    expect(svg).toContain("architecture-strategist");
    expect(svg).toContain("security-sentinel");
    expect(svg).toContain("test-coverage-auditor");
    // model tiers rendered
    expect(svg).toContain(">opus</text>");
    expect(svg).toContain(">sonnet</text>");
    // vote labels rendered
    expect(svg).toContain(">APPROVE</text>");
    expect(svg).toContain(">CONCERN</text>");
    expect(svg).toContain(">PENDING</text>");
  });

  it("renders verify --explain gate rows (gate / status / runner / evidence)", () => {
    const svg = buildSvg(SAMPLE);
    expect(svg).toContain("QUALITY GATES");
    // gate name, runner, evidence, and status all present
    expect(svg).toContain("static_analysis");
    expect(svg).toContain(">tsc</text>");
    expect(svg).toContain("tests failed (rc=1)");
    expect(svg).toContain(">PASS</text>");
    expect(svg).toContain(">FAIL</text>");
  });

  it("stays well-formed SVG with the Autonomi palette after the new sections", () => {
    const svg = buildSvg(SAMPLE);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("#553de9");
    expect(svg).toContain("#1FC5A8");
    // balanced tags: every <text opens and closes
    const opens = (svg.match(/<text\b/g) || []).length;
    const closes = (svg.match(/<\/text>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("XML-escapes hostile run/repo names", () => {
    const svg = buildSvg({ ...SAMPLE, run: '<script>&"x' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("caps a huge fleet so a 171-run registry never explodes the frame", () => {
    const bigFleet = Array.from({ length: 171 }, (_, i) => ({
      name: `run-${i}`,
      phase: "impl",
      iteration: i,
      running: i === 0,
    }));
    const svg = buildSvg({ ...SAMPLE, fleet: bigFleet });
    // The header is honest about active vs total (run-0 is the only running one).
    expect(svg).toContain("FLEET (1 active / 171)");
    // ... but only a capped subset of rows is drawn, with an overflow line.
    // run-0 (first) is shown; a deep run (run-50) must be summarized away.
    expect(svg).toContain(">run-0<");
    expect(svg).not.toContain(">run-50<");
    expect(svg).toMatch(/\+ \d+ more/);
  });

  it("fleet header shows 'none active' when no run is live", () => {
    const stopped = Array.from({ length: 5 }, (_, i) => ({
      name: `run-${i}`,
      path: `/p/${i}`,
      phase: "stopped",
      status: "stopped",
      iteration: 0,
      running: false,
    }));
    const svg = buildSvg({ ...SAMPLE, fleet: stopped });
    expect(svg).toContain("FLEET (5, none active)");
  });
});

// Cold wasm init plus font read plus first rasterize took 5.4s on a cold macOS
// runner (nightly 37686475225), over bun's 5000ms default. Warm once outside
// any test budget and give the real-render tests an explicit generous timeout.
const RENDER_TIMEOUT_MS = 30_000;

describe("cockpit render orchestration", () => {
  beforeAll(async () => {
    const { rasterize } = await import("../src/cockpit/raster.ts");
    await rasterize(buildSvg(SAMPLE));
  }, 60_000);

  it("falls back honestly (no image) when protocol is none", async () => {
    const out = await render(SAMPLE, { protocol: "none" });
    expect(out.kind).toBe("fallback");
    expect(out.data).toBeUndefined();
    expect(out.svg.startsWith("<svg")).toBe(true);
  });

  it("--no-image forces fallback even on a graphics terminal", async () => {
    const out = await render(SAMPLE, { protocol: "iterm2", forceText: true });
    expect(out.kind).toBe("fallback");
    expect(out.reason).toContain("no-image");
  });

  it("renders a real inline image on a graphics terminal via the bundled wasm", async () => {
    // The bundled @resvg/resvg-wasm makes rasterization available out of the
    // box, so a graphics-capable protocol produces a genuine image (not a
    // fallback). The escape carries the encoded PNG bytes.
    const out = await render(SAMPLE, { protocol: "iterm2" });
    expect(out.kind).toBe("image");
    expect(out.protocol).toBe("iterm2");
    expect(out.data).toBeTruthy();
    // iTerm2 inline-image escape shape.
    expect(out.data!.startsWith("]1337;File=inline=1")).toBe(true);
  }, RENDER_TIMEOUT_MS);

  it("renders a malformed/partial state without crashing (graceful degrade)", () => {
    // A truncated/hand-written state (missing verdict, budget, arrays) must
    // still produce a well-formed SVG, not throw and take down the render.
    const svg = buildSvg({} as any);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("UNKNOWN"); // default verdict
    expect(svg).toContain("$0.00");   // default budget
  });

  it("rasterizes text, not just shapes (font fix: fontless wasm renders blank)", async () => {
    // The wasm rasterizer has no system fonts, so without a loaded font buffer
    // every <text> renders blank and the PNG is tiny (~15KB). With the font it
    // is 4-5x larger. Assert the render is font-bearing so a regression that
    // drops the font buffer fails here.
    const { rasterize } = await import("../src/cockpit/raster.ts");
    const r = await rasterize(buildSvg(SAMPLE));
    expect(r.available).toBe(true);
    expect(r.png).toBeTruthy();
    expect(r.png!.length).toBeGreaterThan(30_000);
  }, RENDER_TIMEOUT_MS);
});
