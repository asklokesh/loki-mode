# Phase Merge-3 Implementation Plan: Vite Rebuild with `/lab/` Base

**Status:** Architect-approved 2026-05-23. Dev fleet implements per this plan.
**Owner:** Phase Merge-3 of the v7.5.29+ Purple-Lab-into-Dashboard true-integration arc.
**Predecessors:** `docs/MERGE-ROUTE-MAP.md` (Merge-1), `docs/MERGE-DEDUP-MAP.md` (Merge-2).

## Binding Decisions

1. **Vite `base: '/lab/'`.** Single config change applies in dev + build.
2. **API base via `import.meta.env.BASE_URL`.** No `/lab/` hardcoded in TypeScript -- the env var resolves to `/lab/` at build time and `/` in tests.
3. **`loki web` standalone server ALSO mounts its app under `/lab/`.** Same bundle, same routing model as the merged Dashboard. Root `/` redirects to `/lab/`. Rule 0 preserved by URL shift only.
4. **No duplicated dist artifacts.** Single `web-app/dist/` shipped to npm + Docker. No `base: '/'` second build.

## File Diffs (concrete)

### 1. `web-app/vite.config.ts`
```diff
 export default defineConfig({
   plugins: [react()],
+  base: '/lab/',
   resolve: { alias: { '@': path.resolve(__dirname, './src') } },
   server: {
     port: 5173,
     proxy: {
-      '/api':   { target: 'http://localhost:57375', changeOrigin: true },
-      '/proxy': { target: 'http://localhost:57375', changeOrigin: true, ws: true },
-      '/ws':    { target: 'ws://localhost:57375',   ws: true },
+      '/lab/api':   { target: 'http://localhost:57375', changeOrigin: true },
+      '/lab/proxy': { target: 'http://localhost:57375', changeOrigin: true, ws: true },
+      '/lab/ws':    { target: 'ws://localhost:57375',   ws: true },
     },
   },
 })
```

### 2. `web-app/src/api/client.ts` (line 3 + line 7 area)
```diff
-const API_BASE = (import.meta as any).env?.VITE_API_BASE
-  || `${window.location.origin}/api`;
+const BASE = (import.meta as any).env?.BASE_URL || '/';
+const API_BASE = (import.meta as any).env?.VITE_API_BASE
+  || `${window.location.origin}${BASE}api`;
+const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${BASE}ws`;
```
Then export `WS_BASE` and route any other websocket constructor through it.

### 3. `web-app/src/pages/MagicPage.tsx` (4 hardcoded fetches at lines 43, 65, 86, 106)
Convert each `fetch('/api/magic/...')` to use a shared base. Cleanest fix: import the client API base:
```diff
-      const res = await fetch('/api/magic/components');
+      const res = await fetch(`${import.meta.env.BASE_URL}api/magic/components`);
```
Apply to all 4 sites. Or extract a `magicApi` helper in `web-app/src/api/client.ts`.

### 4. `web-app/src/components/TerminalEmulator.tsx` (line 49)
```diff
-    const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;
+    const wsUrl = `${protocol}//${window.location.host}${import.meta.env.BASE_URL}ws/terminal/${sessionId}`;
```

### 5. `web-app/server.py` -- standalone mount (added in Merge-4; staged here)

The architect's option 2: standalone server self-mounts at `/lab/`. The actual wiring lives in Merge-4, but Merge-3 needs to verify the URL flip works for `loki web`. For Merge-3 alone, we accept the standalone `loki web` URL changes to `http://127.0.0.1:57375/lab/`. Browser-open auto-redirect is added in Merge-4.

### 6. `autonomy/loki` `cmd_web_start` browser-open URL (line ~3694)
Change the `open` URL from `http://127.0.0.1:${PURPLE_LAB_DEFAULT_PORT}/` to `http://127.0.0.1:${PURPLE_LAB_DEFAULT_PORT}/lab/`.

## Release Pipeline Wiring

### 7. Root `package.json` `prepublishOnly` (line ~106)
Append `&& cd ../web-app && npm ci && npm run build && test -f dist/index.html` after the existing legacy-ui build.

### 8. `Dockerfile`
Add `COPY` for web-app build artifacts + server files. Mirror the `dashboard/` COPY pattern. (Merge-4 owns the actual import; Merge-3 ensures files are in the image.)

### 9. `scripts/local-ci.sh`
Add a check between existing steps:
```bash
run_check "web-app build produces /lab/-prefixed assets" \
  '(cd web-app && npm ci --silent && npm run build) && grep -q "/lab/assets/" web-app/dist/index.html'
```

## Tests (Merge-3 acceptance)

| ID | Test | Type |
|---|---|---|
| T1 | `grep -q '/lab/assets/' web-app/dist/index.html` after `npm run build` | bash, local-ci |
| T2 | `grep -q '/lab/api' web-app/dist/assets/index-*.js` (runtime base baked in) | bash, local-ci |
| T3 | `loki web --no-open; curl -sL http://127.0.0.1:57375/lab/ \| grep -q '<div id="root">'` | bash |
| T4 | `curl -s http://127.0.0.1:57375/lab/assets/index-*.js` returns JS not 404 | bash |
| T5 | Playwright: visit `http://127.0.0.1:57375/lab/`, no console 404s, screenshot HomePage baseline | Playwright |
| T6 | (Post-Merge-4) visit `http://127.0.0.1:57374/lab/`, screenshot diff vs T5 pixel-identical | Playwright |
| T7 | `curl -s http://127.0.0.1:57374/` returns Dashboard root unchanged | bash |
| T8 | `npm pack --dry-run \| grep web-app/dist/index.html` succeeds | local-ci |

## Risks (with mitigations)

1. **Hardcoded `/api/` strings drift back over time.** Mitigation: add local-ci grep guard:
   `! grep -rn "['\"]/api\|['\"]/ws" web-app/src/ | grep -v "BASE_URL\|external"`

2. **`/vite.svg` favicon 404 under `/lab/`.** Mitigation: verify `web-app/public/vite.svg` exists; if not, remove the `<link rel="icon" href="/vite.svg">` line from `web-app/index.html`.

3. **Dev workflow break (`http://localhost:5173/` returns 404).** Mitigation: document `http://localhost:5173/lab/` in `web-app/README.md`; optionally add Vite middleware to redirect `/` -> `/lab/` in dev.

4. **Cookies set at root path.** Mitigation: Merge-2 audit confirmed no cookies (Bearer tokens only). Re-verify with curl post-build.

5. **Stale dist in git.** Mitigation: local-ci T1/T2 catch it. Stronger: pre-push hook that runs `npm run build` if src is newer than dist (deferred to follow-up).

## NOT Done In This Phase

- Auto-spawn web-app subprocess from `loki dashboard` (Merge-4).
- Sidebar entry in `legacy-ui-static/index.html` (Merge-6).
- Deep state dedup (Merge-5).
- Deprecation of `loki web` (Merge-7).
- `vite-plugin-html` dev `/` -> `/lab/` redirect (nice-to-have, not blocking).

## Acceptance Gate

Merge-3 ships when: T1-T4 + T7 + T8 green, no `git status` noise outside the planned files, `loki web --no-open` serves the Lab UI at `/lab/` end-to-end with browser-side console clean (verified by Playwright T5).
