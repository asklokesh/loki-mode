# Vendored: Loki mascot web component

`loki-mascot.js` (and `loki-mascot.d.ts`) are VENDORED, not authored here.

## Source

- Repo: `autonomi-saas` (Autonomi, proprietary) -- `packages/loki-mascot/`
- Source commit: `ddbade9` ("feat(loki-mascot): make the package Loki's
  canonical home folder")
- File: `packages/loki-mascot/src/loki-mascot.js`

## Why vendored (copied, not depended on)

loki-mode is a public, BUSL-licensed repo and MUST NOT depend on the
proprietary `autonomi-saas` package. The mascot is a single, zero-dependency,
self-registering classic script (one file), so copying it in is the clean,
license-safe way to give the engine's dashboard the same brand character that
appears on the Autonomi product and landing.

## Why only the `.js` (not the assets/)

The live `<loki-mascot>` component renders its character as inline SVG from its
own internal registry; it does NOT load the `assets/*.svg` files at runtime
(those are a separate, derived export for non-web surfaces). The dashboard only
ever uses the live component, so vendoring just the component file is the
correct minimal footprint. The `.d.ts` is included for reference only; this is
a plain-JS / esbuild project and does not consume it.

## Pinned to the committed version, not the in-flight redesign

At vendor time, a separate effort in autonomi-saas was mid-rewrite of this
component (an "adorability" redesign + new affection emotions), uncommitted and
with its smoke test not yet green. This vendor deliberately pins to the last
committed, smoke-passing version (`ddbade9`, 17 emotions, a11y + reduced-motion
verified). Re-sync when that redesign lands and is verified.

## How to re-sync

```
git -C <autonomi-saas> show <new-commit>:packages/loki-mascot/src/loki-mascot.js \
  > dashboard-ui/components/vendor/loki-mascot/loki-mascot.js
```

Then rebuild the dashboard (`cd dashboard-ui && npm run build:all`) and update
the source commit hash above.
