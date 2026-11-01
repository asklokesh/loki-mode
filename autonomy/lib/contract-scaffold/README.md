# contract-scaffold (M1: the contract-first codegen spine)

The single load-bearing mechanism behind "a real, wired app, not a static shell."
See `artifacts/beat-replit-engineering-plan.md` (studied from Replit's Adopt) and
`artifacts/replit-adopt-study.md`.

## What it does

`scaffold.sh <out_dir> <resource> [field:type ...]` emits a **contract-first**
project skeleton:

1. An **OpenAPI contract** (`openapi.yaml`) as a first-class artifact -- the single
   source of truth for the API.
2. An **Orval config** that generates typed react-query hooks FROM the contract.
3. `package.json` + `tsconfig.json` with a real codegen + typecheck script.

The point: after `npm run codegen`, a page can only call hooks that the contract
defines. A page referencing an endpoint the backend does not implement **fails
typecheck** -- so a static-shell-passed-off-as-wired becomes impossible.

## What it does

- scaffold -> real `openapi.yaml`
- real Orval codegen -> `useListBookmark` / `useCreateBookmark` / `useDeleteBookmark`
- a page on a REAL endpoint typechecks
- a page on a NON-CONTRACT endpoint **fails typecheck** (drift blocked)

Shown on a throwaway `bookmark` resource -- **general by construction, no
knowledge of any specific PRD** (anti-teaching-to-the-test).

## Status: STANDALONE + ADDITIVE -- wired into NO build lane

This is a capability module, like FV-1 was. It changes zero existing build
behavior. **Wiring it into the default build lane is the gated next step** (the
M1->"M1-wire" fork, analogous to FV-1->FV-2): that step touches the parity-locked
`run.sh`/`build_prompt.ts` core, reclassifies what every build produces, and
requires bash+bun parity work + council review + founder sign-off. Do NOT wire it
in as a solo/rushed action.

## Scope

Gap A (the generated app's own quality). NOT Gap B (Replit's managed cloud:
hosted DB provisioning, auth, secrets, deploy infra -- multi-quarter, out).

## M2 -- real backend floor (DONE, standalone)

`generate.mjs <out_dir> <resource> [field:type ...]` produces a REAL Express +
SQLite backend (via `templates/server/`, substitution NOT heredocs) that persists:
POST creates a row that survives to a later GET, DELETE removes it, one seed row so
the first screen is never blank. Every declared field is always bound (a partial
POST persists cleanly, 201, never 500 -- a bug the FV harness caught).

On a throwaway `note` resource it generates,
starts, POST persists, partial POST persists, and **FV-1 reports
functional_status=verified** -- the convergence. A static shell would fail this.

Architecture: template files + a Node substitutor, NOT bash heredocs emitting JS
(heredocs collide with JS `${...}`/backticks -- learned the hard way; see the plan).

## M3 -- design-system pass (DONE, standalone)

`generate.mjs` also emits (into `src/`, from `templates/ui/`) a design system so a
generated frontend looks DESIGNED, not default:
- `theme.css` -- ROLE tokens (bg/surface/text/primary/...), a confident modern
  default palette, and a parallel dark theme honored from the OS (`--no-ui` skips).
- `<Resource>ListView.tsx` -- a data surface with all THREE UI states: a shimmer
  skeleton (never a blank flash), an inviting empty state with a CTA, and a
  first-run "you're viewing sample data" banner (backed by M2's seed row). Wired
  to the M1 contract hook, so it cannot reference a non-contract endpoint.

Small touches that make users smile: friendly copy, a clear primary action,
graceful loading/empty/error states, no raw hex (re-theme from one block).

What it gives you: no raw hex in components, all three
states, dark theme, AND the tokenized ListView TYPECHECKS against the generated
contract hooks (the contract even caught a wrong response-type assumption in the
UI -- the spine working as designed).

## Next (wiring, see the plan)

- Wire M1+M2+M3 into the build lane (GATED: touches parity-locked run.sh/
  build_prompt.ts core -> bash+bun parity + council + founder sign-off).
- Wire the FV harness into the completion verdict (FV-2, founder-gated).
