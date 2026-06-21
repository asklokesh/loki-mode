/*
 * <loki-mascot> - the Loki brand mascot as a framework-agnostic web component.
 *
 * Loki is the little app-creature: a rounded paper "app window" with a friendly
 * face, brought to life in violet ink on warm paper. This component is the
 * canonical, animated, multi-emotion version of that character, designed to
 * appear everywhere the engine is used (landing, app, chat, bots, docs).
 *
 * Design constraints (deliberate, do not "modernize" away):
 *  - Classic (non-module) script that self-registers the <loki-mascot> tag.
 *    No top-level import/export, so the gallery opens by double-click over
 *    file:// (ES modules and fetch do NOT load over file://). Bundlers still
 *    `import "@autonomi/loki-mascot"` and run this as a registering side effect.
 *  - Shadow DOM: host CSS cannot clobber the figure, and the keyframes never
 *    leak out. Brand tokens (--color-ink etc.) inherit THROUGH the shadow
 *    boundary, so embedded in the product it picks up host tokens; standalone
 *    it falls back to the brand-exact hardcoded values.
 *  - Zero dependencies, offline-safe, inline SVG only.
 *  - a11y: the host element carries role="img" + a per-emotion aria-label; the
 *    inner SVG is decorative (aria-hidden). All motion is disabled under
 *    prefers-reduced-motion, resolving to a clean static expression.
 *
 * The base skeleton (body, title bar, legs, ground shadow, cheeks) is the EXACT
 * path data from apps/web AppCreature.tsx so idle Loki is pixel-identical and
 * stays recognizable. Emotions vary ONLY the eyes, mouth, brows and an optional
 * prop, supplied by a data registry so adding a new emotion is one entry.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof customElements === "undefined") {
    // Non-browser (SSR) environment: nothing to register, exit quietly.
    return;
  }

  // --- Eye fragments -----------------------------------------------------
  // Each returns SVG markup for the two eyes. The default eyes are the
  // canonical dot eyes with paper highlights. Coordinates match AppCreature.
  var EYES = {
    open:
      '<circle cx="178" cy="214" r="7" class="fillInk"/>' +
      '<circle cx="244" cy="214" r="7" class="fillInk"/>' +
      '<circle cx="180.5" cy="211.5" r="2" class="fillHi"/>' +
      '<circle cx="246.5" cy="211.5" r="2" class="fillHi"/>',
    // Happy: upturned arcs (closed, content eyes).
    happy:
      '<path class="ink" d="M171 216c4-6 10-6 14 0"/>' +
      '<path class="ink" d="M237 216c4-6 10-6 14 0"/>',
    // Looking up and to the side (thinking / curious).
    lookUp:
      '<circle cx="178" cy="214" r="7" class="fillInk"/>' +
      '<circle cx="244" cy="214" r="7" class="fillInk"/>' +
      '<circle cx="180" cy="210" r="2.4" class="fillHi"/>' +
      '<circle cx="246" cy="210" r="2.4" class="fillHi"/>',
    // Wide, bright eyes (celebrating / proud).
    wide:
      '<circle cx="178" cy="213" r="8.5" class="fillInk"/>' +
      '<circle cx="244" cy="213" r="8.5" class="fillInk"/>' +
      '<circle cx="181" cy="210" r="2.6" class="fillHi"/>' +
      '<circle cx="247" cy="210" r="2.6" class="fillHi"/>',
    // Focused / squinting (building, verifying).
    focused:
      '<path class="inkBold" d="M170 214h16"/>' +
      '<path class="inkBold" d="M236 214h16"/>',
    // Closed eyes, gentle curve down (sleeping).
    closed:
      '<path class="ink" d="M170 214c4 5 10 5 14 0"/>' +
      '<path class="ink" d="M236 214c4 5 10 5 14 0"/>',
    // Worried: small dots set slightly low (concerned / error).
    worried:
      '<circle cx="178" cy="216" r="6" class="fillInk"/>' +
      '<circle cx="244" cy="216" r="6" class="fillInk"/>' +
      '<circle cx="180" cy="213.5" r="1.8" class="fillHi"/>' +
      '<circle cx="246" cy="213.5" r="1.8" class="fillHi"/>',
    // One eye winks (waving / playful).
    wink:
      '<path class="ink" d="M171 214c4-5 10-5 14 0"/>' +
      '<circle cx="244" cy="214" r="7" class="fillInk"/>' +
      '<circle cx="246.5" cy="211.5" r="2" class="fillHi"/>',
  };

  // --- Brow fragments (optional) -----------------------------------------
  var BROWS = {
    none: "",
    // Raised, gently curious.
    raised:
      '<path class="inkThin" d="M168 198c5-3 12-3 17 0"/>' +
      '<path class="inkThin" d="M237 198c5-3 12-3 17 0"/>',
    // Furrowed / concentrating (angled inward).
    furrow:
      '<path class="inkThin" d="M168 199l16 3"/>' +
      '<path class="inkThin" d="M254 199l-16 3"/>',
    // Worried (angled up at the inner edge).
    worried:
      '<path class="inkThin" d="M168 201l16-4"/>' +
      '<path class="inkThin" d="M254 201l-16-4"/>',
  };

  // --- Mouth fragments ---------------------------------------------------
  var MOUTHS = {
    // Canonical warm smile.
    smile: '<path class="ink" d="M192 244c12 12 26 12 38 0"/>',
    // Big open smile (celebrating).
    openSmile:
      '<path class="fillInk" d="M194 243c8 16 26 16 34 0c-10 6-24 6-34 0z"/>',
    // Neutral flat line (thinking, loading).
    flat: '<path class="ink" d="M198 248h26"/>',
    // Small "o" of surprise / curiosity.
    o: '<ellipse cx="211" cy="248" rx="6" ry="7" class="ink"/>',
    // Soft frown (concerned / error).
    frown: '<path class="ink" d="M192 250c12-12 26-12 38 0"/>',
    // Tiny content smile (sleeping, idle calm).
    soft: '<path class="ink" d="M196 246c9 7 19 7 28 0"/>',
    // Proud, closed, slightly smug upward curve.
    proud: '<path class="ink" d="M194 245c10 9 24 9 32 -2"/>',
  };

  // --- Prop fragments (optional, drawn over/around the body) --------------
  // Props that should animate carry their own class hooks.
  var PROPS = {
    none: "",
    // The canonical waving hand on its little arm (cord).
    wave:
      '<g class="prop-wave">' +
      '<path class="ink" d="M318 250c14-2 26 6 28 20"/>' +
      '<circle cx="348" cy="276" r="9" class="fillPaper ink"/>' +
      "</g>",
    // Floating "zzz" for sleep.
    zzz:
      '<g class="ink prop-zzz">' +
      '<text x="300" y="150" class="zzz z1">z</text>' +
      '<text x="322" y="128" class="zzz z2">z</text>' +
      '<text x="344" y="110" class="zzz z3">z</text>' +
      "</g>",
    // Thought dots rising near the head (thinking).
    thoughtDots:
      '<g class="prop-think">' +
      '<circle cx="300" cy="170" r="4" class="fillInk d1"/>' +
      '<circle cx="316" cy="150" r="5.5" class="fillInk d2"/>' +
      '<circle cx="336" cy="126" r="7" class="fillInk d3"/>' +
      "</g>",
    // Magnifier held up to inspect (reviewing).
    magnifier:
      '<g class="prop-magnifier">' +
      '<circle cx="332" cy="250" r="18" class="fillGlass ink"/>' +
      '<path class="inkBold" d="M345 263l16 16"/>' +
      '<path class="inkThin" d="M325 244a10 10 0 0 1 8 4"/>' +
      "</g>",
    // Green verified check badge (verifying / proud).
    check:
      '<g class="prop-check">' +
      '<circle cx="332" cy="246" r="17" class="fillSeal"/>' +
      '<path class="checkMark" d="M324 246l6 6 11 -13"/>' +
      "</g>",
    // Confetti burst (celebrating).
    confetti:
      '<g class="prop-confetti">' +
      '<rect x="110" y="120" width="7" height="7" class="fillInk c1" transform="rotate(20 113 123)"/>' +
      '<rect x="300" y="110" width="7" height="7" class="fillGlow c2" transform="rotate(-15 303 113)"/>' +
      '<rect x="140" y="96" width="6" height="6" class="fillSeal c3"/>' +
      '<circle cx="330" cy="150" r="4" class="fillInk c4"/>' +
      '<circle cx="96" cy="170" r="4" class="fillGlow c5"/>' +
      '<rect x="270" y="140" width="6" height="6" class="fillInk c6" transform="rotate(40 273 143)"/>' +
      '<path class="inkViolet c7" d="M210 92l0 12M204 98l12 0"/>' +
      "</g>",
    // A shipped box / parcel (shipping).
    parcel:
      '<g class="prop-parcel">' +
      '<rect x="316" y="244" width="40" height="34" rx="3" class="fillPaper ink"/>' +
      '<path class="ink" d="M316 256h40"/>' +
      '<path class="inkViolet" d="M336 244v34"/>' +
      "</g>",
    // A spinner ring (loading).
    spinner:
      '<g class="prop-spinner">' +
      '<path class="inkBold spin" d="M332 230a20 20 0 1 1 -14 6"/>' +
      "</g>",
  };

  // --- Emotion registry --------------------------------------------------
  // Each emotion is the variable parts of the face plus a default motion.
  // Adding an emotion = one entry here (add a fragment above only if the
  // eyes / mouth / brow / prop it needs does not exist yet).
  var EMOTIONS = {
    idle: { eyes: "open", mouth: "smile", motion: "breathe", label: "Loki, resting", blink: true },
    happy: { eyes: "happy", mouth: "smile", motion: "bob", label: "Loki, happy" },
    thinking: { eyes: "lookUp", brow: "raised", mouth: "flat", prop: "thoughtDots", motion: "wiggle", label: "Loki, thinking" },
    building: { eyes: "focused", brow: "furrow", mouth: "flat", motion: "work", label: "Loki, building" },
    reviewing: { eyes: "focused", brow: "furrow", mouth: "soft", prop: "magnifier", motion: "inspect", label: "Loki, reviewing the work" },
    verifying: { eyes: "open", mouth: "soft", prop: "check", motion: "bob", label: "Loki, verifying", blink: true },
    celebrating: { eyes: "wide", mouth: "openSmile", prop: "confetti", motion: "bounce", label: "Loki, celebrating a verified result" },
    proud: { eyes: "happy", mouth: "proud", prop: "check", motion: "bob", label: "Loki, proud" },
    waving: { eyes: "wink", mouth: "smile", prop: "wave", motion: "wave", label: "Loki, waving hello" },
    sleeping: { eyes: "closed", mouth: "soft", prop: "zzz", motion: "sleep", label: "Loki, sleeping" },
    concerned: { eyes: "worried", brow: "worried", mouth: "frown", motion: "shake", label: "Loki, something went wrong" },
    shipping: { eyes: "happy", mouth: "smile", prop: "parcel", motion: "launch", label: "Loki, shipping" },
    loading: { eyes: "open", mouth: "flat", prop: "spinner", motion: "breathe", label: "Loki, loading", blink: true },
    curious: { eyes: "lookUp", brow: "raised", mouth: "o", prop: "thoughtDots", motion: "tilt", label: "Loki, curious" },
    blinking: { eyes: "open", mouth: "smile", motion: "breathe", label: "Loki", blink: true },
    walking: { eyes: "open", mouth: "soft", motion: "walk", label: "Loki, walking", blink: true },
    running: { eyes: "focused", mouth: "soft", motion: "run", label: "Loki, running" },
  };

  var DEFAULT_EMOTION = "idle";

  // Legs: drawn separately so the walk/run cycles can animate them.
  function legs() {
    return (
      '<g class="legs">' +
      '<path class="ink leg legL" d="M168 318v18"/>' +
      '<path class="ink foot footL" d="M158 336h20"/>' +
      '<path class="ink leg legR" d="M252 318v18"/>' +
      '<path class="ink foot footR" d="M242 336h20"/>' +
      "</g>"
    );
  }

  function frag(map, key, fallback) {
    if (key && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    return fallback || "";
  }

  // Build the full SVG body for an emotion config.
  function buildSvg(cfg) {
    var blinkClass = cfg.blink ? " blink" : "";
    return (
      '<svg class="figure" viewBox="0 0 420 380" aria-hidden="true" focusable="false">' +
      // ground shadow
      '<ellipse cx="210" cy="338" rx="120" ry="16" class="fillInkWash"/>' +
      // the body breathes / moves as a whole via the motion wrapper
      '<g class="creature">' +
      legs() +
      // body: the rounded app window (canonical path)
      '<path class="fillPaper ink" d="M120 132c0-22 16-36 40-37 38-2 82-2 120 0 24 1 40 15 40 38v118c0 24-16 39-41 40-40 2-78 2-118 0-25-1-41-16-41-40z"/>' +
      // window title bar
      '<path class="inkThin" d="M124 168c54-4 118-4 172 0"/>' +
      '<circle cx="146" cy="150" r="4.5" class="inkViolet"/>' +
      '<circle cx="164" cy="150" r="4.5" class="inkThinDot"/>' +
      '<circle cx="182" cy="150" r="4.5" class="inkThinDot"/>' +
      // cheeks
      '<circle cx="170" cy="232" r="9" class="fillGlow"/>' +
      '<circle cx="252" cy="232" r="9" class="fillGlow"/>' +
      // brows (optional)
      frag(BROWS, cfg.brow, "") +
      // eyes (wrapped so blink can scale them)
      '<g class="eyes' + blinkClass + '">' + frag(EYES, cfg.eyes, EYES.open) + "</g>" +
      // mouth
      frag(MOUTHS, cfg.mouth, MOUTHS.smile) +
      // a violet "content" line, like the app has its first feature
      '<path class="inkViolet" d="M150 280h120"/>' +
      '<path class="inkThin" d="M150 296h84"/>' +
      // prop (optional)
      frag(PROPS, cfg.prop, "") +
      "</g>" +
      "</svg>"
    );
  }

  // The component's own styles. Tokens inherit through the shadow boundary;
  // hardcoded fallbacks keep Loki brand-exact when no host tokens exist.
  var STYLE = [
    ":host{display:inline-block;line-height:0;",
    "--lm-ink:var(--color-ink,#553de9);",
    "--lm-ink-wash:var(--color-ink-wash,rgba(85,61,233,0.08));",
    "--lm-text:var(--color-text,#201515);",
    "--lm-paper:var(--color-paper-card,#fffdf8);",
    "--lm-glow:var(--color-glow,#e8a33d);",
    "--lm-glow-wash:var(--color-glow-wash,rgba(232,163,61,0.14));",
    "--lm-seal:var(--color-seal,#1f8a52);",
    "}",
    ".figure{display:block;width:100%;height:auto;overflow:visible}",

    // ink strokes
    ".ink{fill:none;stroke:var(--lm-text);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}",
    ".inkBold{fill:none;stroke:var(--lm-text);stroke-width:3.4;stroke-linecap:round;stroke-linejoin:round}",
    ".inkThin{fill:none;stroke:var(--lm-text);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}",
    ".inkThinDot{fill:none;stroke:var(--lm-text);stroke-width:1.6}",
    ".inkViolet{fill:none;stroke:var(--lm-ink);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}",

    // fills
    ".fillPaper{fill:var(--lm-paper)}",
    ".fillInk{fill:var(--lm-ink)}",
    ".fillInkWash{fill:var(--lm-ink-wash)}",
    ".fillGlow{fill:var(--lm-glow)}",
    ".fillSeal{fill:var(--lm-seal)}",
    ".fillGlass{fill:rgba(85,61,233,0.06)}",
    ".fillHi{fill:var(--lm-paper)}",
    ".prop-wave .fillPaper{fill:var(--lm-paper)}",
    ".checkMark{fill:none;stroke:#fff;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}",
    ".zzz{font:600 26px var(--font-sans,system-ui,sans-serif);fill:var(--lm-ink)}",

    // ---- motion ----------------------------------------------------------
    // The whole creature moves via .creature; parts via their own hooks.
    ".m-breathe .creature{transform-box:fill-box;transform-origin:center;animation:lm-breathe 4.5s ease-in-out infinite}",
    "@keyframes lm-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-2px) scale(1.012)}}",

    ".m-bob .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-bob 2.2s ease-in-out infinite}",
    "@keyframes lm-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}",

    ".m-bounce .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-bounce 0.9s cubic-bezier(.3,.7,.4,1) infinite}",
    "@keyframes lm-bounce{0%,100%{transform:translateY(0) scaleY(1)}30%{transform:translateY(-22px) scaleY(1.05)}55%{transform:translateY(0) scaleY(.94)}70%{transform:translateY(-6px)}}",

    ".m-wiggle .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-wiggle 3s ease-in-out infinite}",
    "@keyframes lm-wiggle{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}}",

    ".m-tilt .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-tilt 3.4s ease-in-out infinite}",
    "@keyframes lm-tilt{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}",

    // "work" = a focused little shimmy
    ".m-work .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-work 0.7s ease-in-out infinite}",
    "@keyframes lm-work{0%,100%{transform:translateX(0) rotate(0)}25%{transform:translateX(-1.5px) rotate(-1deg)}75%{transform:translateX(1.5px) rotate(1deg)}}",

    // "inspect" = leaning in with the magnifier
    ".m-inspect .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-inspect 3.2s ease-in-out infinite}",
    "@keyframes lm-inspect{0%,100%{transform:translate(0,0)}50%{transform:translate(6px,-2px)}}",
    ".m-inspect .prop-magnifier{transform-box:fill-box;transform-origin:332px 250px;animation:lm-inspect-mag 3.2s ease-in-out infinite}",
    "@keyframes lm-inspect-mag{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(4px,4px) scale(1.08)}}",

    // shake = concerned head-shake
    ".m-shake .creature{transform-box:fill-box;transform-origin:center;animation:lm-shake 0.5s ease-in-out infinite}",
    "@keyframes lm-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}",

    // launch = the shipping lift-off
    ".m-launch .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-launch 1.6s ease-in-out infinite}",
    "@keyframes lm-launch{0%{transform:translateY(0)}40%{transform:translateY(-3px)}70%{transform:translateY(-14px) rotate(-2deg)}100%{transform:translateY(0)}}",

    // wave motion = body still, hand sways
    ".m-wave .creature{transform-box:fill-box;transform-origin:center;animation:lm-breathe 4.5s ease-in-out infinite}",

    // sleep = slow, deep breathe + drifting z's
    ".m-sleep .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-sleep 5.5s ease-in-out infinite}",
    "@keyframes lm-sleep{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-1px) scale(1.02)}}",

    // ---- part-level motion (run regardless of wrapper) -------------------
    // Waving hand always sways when present.
    ".prop-wave{transform-box:fill-box;transform-origin:50% 100%;animation:lm-sway 1.1s ease-in-out infinite}",
    "@keyframes lm-sway{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(14deg)}}",

    // thought dots rise and fade
    ".prop-think .d1{transform-box:fill-box;transform-origin:center;animation:lm-rise 2.4s ease-in-out infinite}",
    ".prop-think .d2{transform-box:fill-box;transform-origin:center;animation:lm-rise 2.4s ease-in-out infinite .3s}",
    ".prop-think .d3{transform-box:fill-box;transform-origin:center;animation:lm-rise 2.4s ease-in-out infinite .6s}",
    "@keyframes lm-rise{0%{opacity:.2;transform:translateY(4px) scale(.7)}50%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:.2;transform:translateY(-4px) scale(.7)}}",

    // z's float up
    ".zzz{opacity:0;transform-box:fill-box;transform-origin:center}",
    ".prop-zzz .z1{animation:lm-zfloat 3s ease-in-out infinite}",
    ".prop-zzz .z2{animation:lm-zfloat 3s ease-in-out infinite 1s}",
    ".prop-zzz .z3{animation:lm-zfloat 3s ease-in-out infinite 2s}",
    "@keyframes lm-zfloat{0%{opacity:0;transform:translateY(6px) scale(.7)}40%{opacity:1}100%{opacity:0;transform:translateY(-16px) scale(1.1)}}",

    // spinner ring spins
    ".spin{transform-box:fill-box;transform-origin:332px 250px;animation:lm-spin 1s linear infinite}",
    "@keyframes lm-spin{to{transform:rotate(360deg)}}",

    // confetti pieces tumble
    ".prop-confetti>*{transform-box:fill-box;transform-origin:center;animation:lm-confetti 1.4s ease-in infinite}",
    ".prop-confetti .c2{animation-delay:.15s}.prop-confetti .c3{animation-delay:.3s}",
    ".prop-confetti .c4{animation-delay:.45s}.prop-confetti .c5{animation-delay:.2s}",
    ".prop-confetti .c6{animation-delay:.5s}.prop-confetti .c7{animation-delay:.1s}",
    "@keyframes lm-confetti{0%{opacity:0;transform:translateY(0) rotate(0)}20%{opacity:1}100%{opacity:0;transform:translateY(34px) rotate(180deg)}}",

    // check badge pops in
    ".prop-check{transform-box:fill-box;transform-origin:332px 246px;animation:lm-pop 2.4s ease-in-out infinite}",
    "@keyframes lm-pop{0%,70%,100%{transform:scale(1)}80%{transform:scale(1.18)}}",

    // parcel lifts with the body on launch
    ".m-launch .prop-parcel{transform-box:fill-box;transform-origin:center;animation:lm-bob 1.6s ease-in-out infinite}",

    // ---- walk / run cycles ----------------------------------------------
    // Body bobs; legs swing in opposite phase.
    ".m-walk .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-walkbody 0.8s ease-in-out infinite}",
    "@keyframes lm-walkbody{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-4px) rotate(1deg)}}",
    ".m-walk .legL{transform-box:fill-box;transform-origin:168px 318px;animation:lm-legswing 0.8s ease-in-out infinite}",
    ".m-walk .footL{transform-box:fill-box;transform-origin:168px 336px;animation:lm-legswing 0.8s ease-in-out infinite}",
    ".m-walk .legR{transform-box:fill-box;transform-origin:252px 318px;animation:lm-legswing 0.8s ease-in-out infinite .4s}",
    ".m-walk .footR{transform-box:fill-box;transform-origin:252px 336px;animation:lm-legswing 0.8s ease-in-out infinite .4s}",
    "@keyframes lm-legswing{0%,100%{transform:rotate(-16deg)}50%{transform:rotate(16deg)}}",

    ".m-run .creature{transform-box:fill-box;transform-origin:center bottom;animation:lm-runbody 0.42s ease-in-out infinite}",
    "@keyframes lm-runbody{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-7px) rotate(2deg)}}",
    ".m-run .legL{transform-box:fill-box;transform-origin:168px 318px;animation:lm-runleg 0.42s ease-in-out infinite}",
    ".m-run .footL{transform-box:fill-box;transform-origin:168px 336px;animation:lm-runleg 0.42s ease-in-out infinite}",
    ".m-run .legR{transform-box:fill-box;transform-origin:252px 318px;animation:lm-runleg 0.42s ease-in-out infinite .21s}",
    ".m-run .footR{transform-box:fill-box;transform-origin:252px 336px;animation:lm-runleg 0.42s ease-in-out infinite .21s}",
    "@keyframes lm-runleg{0%,100%{transform:rotate(-30deg)}50%{transform:rotate(30deg)}}",

    // ---- blink (overlaid on any emotion that opts in) --------------------
    ".eyes.blink{transform-box:fill-box;transform-origin:center;animation:lm-blink 6s steps(1,end) infinite}",
    "@keyframes lm-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}",

    // ---- reduced motion: resolve to a clean, static expression ----------
    "@media (prefers-reduced-motion: reduce){",
    ".figure *{animation:none !important}",
    ".eyes.blink{transform:scaleY(1) !important}",
    ".zzz{opacity:1}",
    ".prop-confetti>*{opacity:1}",
    ".prop-think .d1,.prop-think .d2,.prop-think .d3{opacity:1}",
    "}",
  ].join("");

  function clampSize(raw) {
    var n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) return 132;
    // generous but sane bounds
    if (n < 16) return 16;
    if (n > 1024) return 1024;
    return n;
  }

  var LokiMascot = (function () {
    function define() {
      return class LokiMascotElement extends HTMLElement {
        static get observedAttributes() {
          return ["emotion", "size", "motion"];
        }

        constructor() {
          super();
          this.attachShadow({ mode: "open" });
          this._styleEl = document.createElement("style");
          this._styleEl.textContent = STYLE;
          this._wrap = document.createElement("div");
          this._wrap.className = "lm-root";
          this.shadowRoot.appendChild(this._styleEl);
          this.shadowRoot.appendChild(this._wrap);
        }

        connectedCallback() {
          this._render();
        }

        attributeChangedCallback() {
          if (this.shadowRoot) this._render();
        }

        _render() {
          var name = (this.getAttribute("emotion") || DEFAULT_EMOTION).toLowerCase();
          var cfg = EMOTIONS[name] || EMOTIONS[DEFAULT_EMOTION];
          var motion = (this.getAttribute("motion") || cfg.motion || "breathe").toLowerCase();

          var size = clampSize(this.getAttribute("size") || "132");
          this.style.width = size + "px";

          // a11y lives on the host; inner SVG stays decorative.
          this.setAttribute("role", "img");
          this.setAttribute("aria-label", cfg.label || "Loki");

          this._wrap.className = "lm-root m-" + motion;
          this._wrap.innerHTML = buildSvg(cfg);
        }
      };
    }

    if (!customElements.get("loki-mascot")) {
      customElements.define("loki-mascot", define());
    }
    return customElements.get("loki-mascot");
  })();

  // Expose the emotion list for tooling / galleries (read-only convenience).
  // Non-enumerable so it does not pollute the element prototype surface.
  try {
    LokiMascot.emotions = Object.keys(EMOTIONS);

    // The single source of truth for an emotion's config. Used by the asset
    // generator so assets/emotions/*.svg are DERIVED from this registry, never
    // hand-maintained copies that could drift.
    LokiMascot.getEmotion = function (name) {
      var key = (name || DEFAULT_EMOTION).toLowerCase();
      var cfg = EMOTIONS[key] || EMOTIONS[DEFAULT_EMOTION];
      // shallow copy so callers cannot mutate the registry
      return Object.assign({ name: key }, cfg);
    };

    // Render a fully standalone, self-contained SVG document for one emotion:
    // the composed character plus its own scoped styles and motion, openable
    // directly (double-click) and embeddable anywhere a static SVG is accepted
    // (README images, slides, favicons, bot avatars, social cards). This is the
    // same render path the component uses; only the style host selector and the
    // outer wrapper differ so it stands alone instead of living in a shadow root.
    LokiMascot.renderStandaloneSVG = function (name) {
      var cfg = LokiMascot.getEmotion(name);
      var motion = cfg.motion || "breathe";
      // The component scopes the token block to :host. For a standalone SVG
      // there is no host element, so re-root just that block onto the svg
      // itself. The motion selectors (.m-walk .creature etc) are descendant
      // selectors and keep working once the svg carries the m-<motion> class,
      // so they need no rewriting.
      var css = STYLE.replace(":host{", "svg.loki-figure{");
      var body = buildSvg(cfg)
        // tag the root svg so the re-rooted :host rules apply, and carry the
        // motion class so the standalone file animates on its own.
        .replace(
          '<svg class="figure"',
          '<svg xmlns="http://www.w3.org/2000/svg" class="figure loki-figure m-' +
            motion +
            '" role="img" aria-label="' +
            (cfg.label || "Loki") +
            '"'
        )
        .replace('aria-hidden="true" focusable="false"', 'focusable="false"');
      // inline the (re-rooted) stylesheet inside the svg via a <style> element
      return body.replace("</svg>", "<style>" + css + "</style></svg>");
    };
  } catch (e) {
    /* frozen environments: ignore */
  }
})();
