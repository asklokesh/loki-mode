// Check 0B probe: runs the REAL verify.ts base-signature code (runLintChecks -> tscUntouchedLocal/tscOnBase, and
// subtractBase through the exported verify stage pieces) on a fixture repo given on argv. No model call.
import { depsSeeHead, baseDepsLinker } from "../../../loki-ts/src/util/base_guard.ts";
import { runLintChecks, type VerifyCheck } from "../../../loki-ts/src/engine10/stages/verify.ts";
import { manifestModel } from "../../../loki-ts/src/runner/repo_profile.ts";
import { validateAnswer } from "../../../loki-ts/src/project_model/schema.ts";
import { projectApi } from "../../../loki-ts/src/project_model/api.ts";
const [repo, baseSha, pkg, ...changed] = process.argv.slice(2);
const pkgDir = `${repo}/${pkg}`;
console.log(JSON.stringify({ step: "depsSeeHead", pkg, value: depsSeeHead(pkgDir, repo!) }));
const events: unknown[] = [];
const ctx = { repoDir: repo, baseSha, emit: (t: string, s: string, d: unknown) => events.push({ t, s, d }), outputs: () => ({}) } as never;
const raw = manifestModel(repo!); const v = raw && !("fanOut" in raw) ? validateAnswer(repo!, raw) : null;
const api = v && v.ok ? projectApi(v.model) : null; console.log(JSON.stringify({ step: "projectModel", ok: !!api, raw: raw && "fanOut" in raw ? raw : undefined }));
const checks: VerifyCheck[] = [];
const pre = await runLintChecks(ctx, changed, new AbortController().signal, checks, { api, keep: new Set(changed) });
console.log(JSON.stringify({ step: "runLintChecks", checks: checks.map((c) => ({ name: c.name, result: c.result, first_error: c.first_error })), pre_existing: pre }));
