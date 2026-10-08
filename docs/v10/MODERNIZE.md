# Loki 10 Part 2: `loki modernize` design

Source: the D30 directive as dispatched on 2026-09-28 (PROGRESS.md 01:51Z entry). D30 has no row in DECISIONS.md yet. The moat order holds: nothing here weakens the Seal, the Wall, Rule of Two or honest verdicts. I read main at 677f88dd. Every file:line cited below comes from that tree.

## 1. Goals and non-goals

**Goals**
- One command, `loki modernize <repo> --to "<target>"`, converts a codebase with no human steps and survives restarts.
- Every converted unit has a Wall made of behavior captured from the OLD code before any change.
- Claims stop exactly where equivalence data stops. Units without proof are listed as NOT PROVEN, with a reason.
- Cost, wall time and risk are printed before any model spend. `--budget` is a hard stop.
- First targets: Python 2 to 3, then Java 8 to 21. COBOL to Java and AngularJS to React come after the eval gates pass on the first two (section 6).

**Non-goals**
- No change to the legacy `loki migrate` (`autonomy/loki:17489`, `dashboard/migration_engine.py`). It is legacy engine code, `autonomy/loki` is on the no-edit list, and its phase gates are agent-judged rather than behavior-captured. It stays as it is.
- No model-judged equivalence. Equivalence is a deterministic diff over captured cases.
- No claim of "complete" for a codebase unless every unit is proven equivalent.
- No new always-on prompt text outside the cache-stable prefix.
- No flip of the engine default. `loki modernize` reaches engine10 whatever the default is (section 2).

## 2. CLI and flags

```
loki modernize <repo> --to "<target>" [--budget USD] [--workers N] [--remote URL]
               [--resume <mid>] [--dry-run] [--provider P] [--no-pr]
```

| Flag | Meaning |
|---|---|
| `--to` | Required. Resolves to a target module: `python3`, `java21`. Later: `java` from COBOL, `react`. An unknown target exits 2 and lists the supported ones. |
| `--budget` | USD hard cap for the whole modernization. Dispatch stops when spent plus the in-flight estimate would exceed it. |
| `--workers` | Concurrent unit workers. Default 4, max 32 locally. With `--remote`, the cap comes from the cluster. |
| `--resume <mid>` | Resumes from the modernization event log at unit level (section 5). |
| `--dry-run` | Runs Inventory only. Prints the unit count, wave plan and estimate, then exits 0 with zero model spend. |
| `--remote URL` | Dispatches units to POST /jobs on a cluster (section 3.4). |

**Routing**
- `bin/loki` gets one `modernize)` arm ahead of the `LOKI_ENGINE` block that execs `bun "$BUN_CLI" engine10 modernize "$@"`, so the legacy default tonight does not block it.
- The engine10 `cli.ts` TABLE gets `modernize: { module: "modernize/cli.ts", fn: "main" }`.
- Without bun, the command exits 1 with a one-line hint. It never falls back to `loki migrate`.

**Modernization id:** `mod-<utc>-<short>`. All state lives under `<repo>/.loki/modernize/<mid>/`.

## 3. The pipeline

**Event log**
- Each modernization has one append-only log at `.loki/modernize/<mid>/events.jsonl`.
- It reuses `events.ts` (`EventLog`, `fold`, `tail`) and the supervisor's running-sha256 single-writer pattern (`supervisor.ts:84 SupervisorLog`).
- `validateEnvelope` (`events.ts:13`) accepts any non-empty type string, so the modernize event types live in `modernize/types.ts` and `engine10/types.ts` stays unedited.
- Each unit is an ordinary v10 run under `.loki/runs/<run-id>/`. The modernize log references it by run id.

### 3.1 Inventory (deterministic, no model spend)

**Inputs:** the repo path and the target.

**Work**
- **Files:** `repomap.listRepoFiles` (`repomap.ts:29`, `git ls-files`), with no file cap in this mode.
- **Languages and build system:** detected by extension and marker files (`setup.py`, `pyproject.toml`, `tox.ini`, `pom.xml`, `build.gradle`).
- **Entry points:** console scripts, `__main__`, `main(String[])`, servlet or web.xml.
- **Existing tests:** `testmap.buildTestMap` (`testmap.ts:174`).
- **Dependency graph**
  - Python: import extraction with the stdlib `tokenize`, which lexes Python 2 source (print statements included) where py3 `ast` cannot parse it.
  - Java: `jdeps -verbose:class` over compiled classes, since jdeps ships with the JDK. If the build fails, fall back to scanning `import` lines and record the fallback in the inventory.
- **Clustering:** Tarjan SCC condensation, packing of nodes into units under the sizing rule (section 4), and topological layers of the unit DAG, which become the waves.
- **Risk score per unit:** size, fan-in, test coverage of the existing suite, and a legacy score (density of removed APIs: py2 `print`, `unicode`, `iteritems`; Java JAXB, `sun.*`, finalizers, `SecurityManager`).

**Prior art examined and not reused**
- `project_graph.ts` discovers cross-project app members, not a code dependency graph.
- `loki_graph_query` (`mcp/server.py:2531`) needs an external graphify build. When `graphify-out/` exists, Inventory reads its edges as a cross-check only and never depends on them.

**Outputs:** `inventory.json` (files, languages, build, entry points, tests, graph edges, units, waves) and `estimate.json`.

**Estimate**
- Cost: units x per-unit cost prior. The prior comes from the cache (`eta.ts` history, `cost.ts` records), else from the Legacy-Bench pilot median.
- Wall time: critical path of waves x p50 unit time / workers.
- Risk: each unit's risk class.
- The estimate prints before any spend. A missing prior prints "not measured", never $0.

**Events:** `modernize.started`, `inventory.completed`, `estimate.printed`.

**Failure handling:** an unparseable file becomes its own unit with a risk flag. It is not dropped. An undetectable build system stops the run with exit 2 before any spend.

### 3.2 Oracle capture (before any change)

**Inputs:** the units, plus the OLD runtime (python2.7, or a JDK 8 toolchain).

**Old runtime:** its location is taken from `LOKI_MOD_OLD_RUNTIME`, or from PATH discovery. If it is missing, capture fails and every unit is NOT PROVEN "old runtime unavailable". Capture is never skipped.

**Work**
- Run the existing suite under the old runtime with branch coverage: coverage.py branch mode on 2.7, or the JaCoCo agent.
- Record I/O at unit boundaries (section 7).
- Run a coverage-guided input search. A read-only provider session sees the old unit's source and the uncovered branches, and proposes inputs. The harness executes them and keeps only the inputs that add branches. It stops at a plateau (two rounds with no gain) or at the unit's capture budget. This follows the witness-search result: 91.9% branch coverage with every generated case at parity (V10-RESEARCH section 7).
- Replay every case twice on the old runtime. A field that differs between the replays is marked nondeterministic.

**Seal**
- Each case file gets a sha256 and a sealed copy under `.loki/modernize/<mid>/oracle/<unit>/`, the same pattern as `wall.sealed`.
- About 20% of cases per unit are held out. The implementer never sees them, and they are checked only at verify (V10-RESEARCH section 1: visible oracles get inlined).

**Coverage floor**
- A unit whose captured branch coverage is below 80% gets one more capture round.
- If it is still below 80%, it is flagged `NOT PROVEN: coverage <x>% below 80%` in the up-front report and still converted. Its verdict can never exceed PARTIAL.

**Outputs:** `oracle/<unit>/cases.jsonl`, `oracle/<unit>/coverage.json`, `oracle/<unit>/sealed.json` (the hashes).

**Events:** `oracle.captured` (per unit: cases, held_out, branch_pct), `oracle.flagged`.

**Honest-verdict rule:** a boundary whose text or bytes type is undeclared, or a field that is nondeterministic with no declared normalizer, is NOT PROVEN for that field. It is never auto-masked.

### 3.3 Plan in waves

**Inputs:** `inventory.json` and the oracle results.

**Work**
- Waves are topological layers, leaves first. A dependency cycle is one unit. It is never split across waves.
- Each unit card holds: unit id, files, entry symbols, target, dependencies, oracle path, risk, model route and caps.
- The target module adds the strangler adapter (section 8), so old and new coexist and every wave builds, runs and ships alone.

**Output:** `plan.json` plus `units/<unit>.md`, the brief each unit run receives. **Event:** `unit.planned`.

**Failure handling:** a wave that cannot build alone is merged into the next wave and the merge is recorded. The plan never ships a wave that needs a later one.

### 3.4 Execute in parallel

**Unit runs**
- Each unit is one v10 engine run (`runSupervisor`, `supervisor.ts:174`) in its own git worktree. That keeps a single writer per unit (V10-RESEARCH section 4).
- The brief is the unit card. The Wall is the sealed oracle plus the target-conformance check (section 7).
- Deterministic codemods run first when installed: `python-modernize` or futurize for py2 to 3, OpenRewrite `UpgradeToJava21` for Java. The model fixes only what the codemods miss. A missing tool emits `codemod.skipped`, and the model does the whole unit.

**Model cascade**
- Sonnet first. Opus only on a failed Wall or failed test. Escalation is triggered by a failed check, never by self-assessment (V10-RESEARCH section 3).
- Units in the top legacy-risk class go straight to opus.
- A unit that fails once gets best-of-2: two fresh sessions from the same base. The first variant that is equivalent on all cases, held-out cases included, wins.

**Workers**
- Local mode: N workers under a coordinator in `modernize/scheduler.ts`. The coordinator is the modernize log's single writer.
- Remote mode:
  - Units go to POST /jobs (`autonomy/trigger-server.py:13`) as `{"kind":"unit","card":...,"base":<sha>}`, bearer-token authenticated.
  - The Helm `job-worker.yaml` gains a `worker.engine: v10` value, because today it runs `loki start`, which is the legacy engine.
  - Workers return a patch plus a receipt through GET /jobs/<id>/proof and hold no push credential.
  - The coordinator re-runs the equivalence check locally on every returned patch before accepting it. A remote receipt alone is never trusted (Rule of Two).

**Caps**
- Per-unit hard cap: the engine cap plus a cost cap from `estimate.json` x 3.
- On `--budget`, the coordinator stops dispatching, finishes in-flight units, and writes the report.

**Events:** `wave.started`, `unit.started` (run_id, model, worker), `unit.variant`, `budget.hit`.

### 3.5 Verify

**Per unit**
- Differential equivalence: old against new on every captured case, held-out cases included (section 7).
- Target conformance.
- The no-op ablation from V10-RESEARCH section 1: replace the new unit with stubs, and the checker must go red. A checker that stays green marks the unit NOT PROVEN "oracle does not constrain unit".
- A captured-literal scan: new source that contains any held-out expected output verbatim is refused.

**Per wave:** full build and integration tests under the target runtime, plus the original suite.

**Fix and re-slice**
- A unit that is not equivalent after its fix rounds (`MAX_FIX_ROUNDS`) and best-of-2 is re-sliced smaller: the unit is re-clustered at function granularity, to a depth of 2.
- After that it is NOT PROVEN with the failing case ids. It is never force-passed.

**Events:** `unit.equivalence` (pass, fail, rate, branch_pct), `unit.resliced`, `unit.completed`, `unit.not_proven`, `wave.verified`.

### 3.6 Ship

**PRs**
- One PR per wave through the existing credentialed push path (`stages/pr.ts`, `autonomy/lib/engine10-push.sh`), run only in the supervisor-side process.
- The PR body lists each unit: equivalence rate, coverage, NOT PROVEN reasons, run id and receipt sha256. Deep verify then runs on the PR as it does today.
- A wave PR is a draft unless every unit in it is proven.

**Routing and reversibility**
- Routing flags in `routes.json` switch traffic module by module (section 8).
- A wave stays reversible, with the old path kept, until all its units are proven equivalent. Only then does a later wave remove the old path.

**Events:** `wave.shipped` (pr url, draft), `route.switched`.

### 3.7 Durable and observable

- **Resume:** `--resume <mid>` folds the log.
  - Units with `unit.completed` or `unit.not_proven` are skipped.
  - In-flight units resume through the existing `loki --resume <run-id>` (E-39).
  - Units that never started are dispatched again.
- **Tamper:** a sha mismatch on the modernize log refuses every ship (`TAMPER_NOT_PROVEN`, `supervisor.ts:20`).
- **Budgets:** the global budget plus the per-unit hard caps.
- **Dashboard:** a new view on the engine10 dashboard (section 10).

### 3.8 Final report

**Files:** `report.json` and `report.md` under `.loki/modernize/<mid>/`.

**Contents**
- Units converted.
- Proven equivalent, with coverage.
- NOT PROVEN, each with its exact reason.
- Total cost (null prints "not measured") and wall time.
- Human touches: a count of operator-input events. The target is 0.

**Verdict**
- COMPLETE only when every unit is proven.
- Otherwise PARTIAL, with the counts.
- FAILED when no wave shipped.

The report never states more than the equivalence data proves. It is sealed and signed through `stages/seal.ts` (`receipt_jwt.py`). UNSIGNED is stated when there is no key. **Event:** `modernize.completed`.

## 4. Unit sizing rule

- **The horizon.** METR's 50% time horizon is about 320 minutes (Opus 4.5), and the 80% horizon is much shorter (V10-RESEARCH section 4).
- **The rule.** A unit must be convertible in well under the 80% horizon. The design sets the target at one quarter of the 50% horizon: 80 human-equivalent minutes per unit.
- **The deterministic proxy.** Inventory cannot measure minutes, so it uses a line cap. The starting value is 1,500 non-blank source lines per unit, with at most 40 files.
  - This number is a starting heuristic, not a research result.
  - The Legacy-Bench pilot (M-27) calibrates it: raise it while first-pass equivalence stays at 90% or higher, lower it when it does not.
- **Cycles and re-slicing.** An SCC larger than the cap stays one unit, flagged high risk, and routed to opus. Re-slicing (3.5) is the release valve.
- **Why parallel works here.** Parallelism gains only on decomposable work (+81%) and loses 39-70% on sequential work. Units in the same wave are independent by construction, and the waves themselves run in sequence.

## 5. Durability and resume

- **State:** everything is on disk under `.loki/modernize/<mid>/`: `events.jsonl`, `inventory.json`, `plan.json`, `oracle/`, `units/`, `routes.json`, `report.*`.
- **Writes:** atomic (a temp file, then rename), the same as `writeEngineMarker` (`supervisor.ts:65`).
- **Recovery:** a crash at any point is recovered by folding the log. No step depends on in-memory state that is not in the log.
- **Worktrees:** unit worktrees live under `.loki/modernize/<mid>/wt/<unit>`. Resume reattaches a worktree when its HEAD matches the recorded base, and otherwise recreates it from the recorded base.
- **The resume test** (M-22) kills the coordinator mid-wave. It asserts that no unit runs twice to completion and that seq keeps increasing.

## 6. Why Python 2 to 3 and Java 8 to 21 first, and COBOL later

**Python 2 to 3**
- Both interpreters run locally.
- coverage.py supports branch mode on 2.7.
- The 2/3-compatible intermediate form lets old and new coexist in one tree.
- Codemods exist.

**Java 8 to 21**
- JDK 21 runs Java 8 bytecode, so modules at different levels coexist in one JVM.
- JaCoCo, jdeps, jdeprscan and OpenRewrite are mature open source.
- Randoop generates regression tests, which feed the input search.

**COBOL to Java**
- It needs a GnuCOBOL or mainframe runtime and file or copybook I/O capture. It also has no in-process boundary, and Legacy-Bench scores run 16.9-42.5% (V10-RESEARCH section 7).
- The research gives a method (witness search, symbolic execution plus delta debugging) but no tooling we have.
- It starts after the first two targets meet the gates in section 12.

**AngularJS to React** follows COBOL. It needs browser-level capture (Playwright traces) as the oracle.

## 7. Oracle capture per language family, and the equivalence checker contract

**Python 2 to 3 capture** (`autonomy/lib/modernize/py_capture.py`, runs on 2.7 and 3.x)
- A tracer wraps each unit's public entry symbols and records arguments, return value, raised exception type and message, stdout, and file writes under a temp root.
- **Serialization is type-tagged canonical JSON, never pickle.** A py2 `str` crossing into py3 is ambiguous, and pickle makes cases falsely equal or falsely different. Tags: `{"t":"bytes","v":<base64>}`, `{"t":"text","v":...}`, `{"t":"int"}`, `{"t":"float","v":...}`, `list`, `dict` (sorted keys), `none`, `exc`.
- **Boundary declaration.** Each unit declares text or bytes per boundary in its card. Inventory proposes a declaration from literal and codec usage. An undeclared boundary is NOT PROVEN.

**Java 8 to 21 capture** (`autonomy/lib/modernize/java_capture.sh` plus `modernize/oracle/java.ts`)
- Run the existing JUnit suite under JDK 8 with the JaCoCo agent. Add Randoop-generated regression tests per unit class, filtered to deterministic ones by the double replay.
- Cases record the method, serialized arguments (JSON through reflection, primitives, strings and collections only), the return value, the exception class and stdout.
- A unit whose boundary types are not serializable is NOT PROVEN "boundary not capturable". The run does not guess.

**Equivalence checker contract** (`modernize/equiv.ts`)

| Part | Detail |
|---|---|
| Input | The unit id, the sealed `cases.jsonl` (sha-verified before use), the new tree, and the target runner. |
| Normalizers | Declared per unit in the card and sealed with the oracle: float tolerance, set ordering, and named nondeterministic fields. Nothing is implicit. |
| Output | `{unit, cases, pass, fail, held_out_pass, held_out_fail, rate, branch_pct, failures:[{case, field, old, new}] (max 20), not_proven:[...]}` |
| Proven equivalent | rate = 100%, held-out rate = 100%, branch_pct of 80% or higher, the no-op ablation goes red, and conformance passes. |
| Otherwise | PARTIAL with the numbers, or FAILED when rate < 100% after re-slice. |

**Target conformance**
- The captured oracle passes on the OLD code by construction. The Wall therefore also carries a check that the old code fails:
  - py3: the unit imports and runs its cases under python3;
  - java21: it compiles with `--release 21` and `jdeprscan --for-removal --release 21` is clean.
- The Wall runs under the target runtime. A Wall that is green before any change is a design error reported as `oracle.flagged`. It is never ALREADY_SATISFIED.
- `stages/wall.ts` gains a pre-sealed mode (M-14) that takes these files instead of running the author session.

## 8. Strangler adapters and routing flags per target

| Target | Coexistence pattern | Routing flag |
|---|---|---|
| Python 2 to 3 | Waves convert units to 2/3-compatible form (`__future__`, `six`), so the tree runs on both interpreters. The final wave drops 2.7 compatibility. | `routes.json` unit -> `py2`, `dual` or `py3`. The generated `tox.ini` envs run the suite on each interpreter a unit claims. |
| Java 8 to 21 | Each Maven or Gradle module moves its `release` level independently. JDK 21 loads the modules still at 8. Removed-API shims (JAXB and so on) come in as explicit dependencies. | `routes.json` module -> `8` or `21`. The target module writes the per-module compiler release into the build file. |
| COBOL to Java (later) | A CALL-boundary adapter: a batch step switch or program alias, so old and new programs share files. | The step-level switch in the job definition. |
| AngularJS to React (later) | `react2angular` wrappers per component, with route-level cutover. | Per-route flag. |

- Every switch emits `route.switched`.
- Switching back is always allowed until the wave is fully proven.

## 9. Wave shipping

1. Wave verify passes.
2. One PR is opened, with a table of unit receipts.
3. Deep verify runs.
4. Routes switch for the proven units only.
5. The next wave starts from the merged tree.

- Waves ship even when some units are NOT PROVEN. Those units keep the old route, and the PR is a draft that names them.
- `--no-pr` keeps everything local for evals.

## 10. Dashboard view

- A `/modernize/<mid>` page on the existing 127.0.0.1-only engine10 dashboard (`dashboard/server.ts`), folded from the modernize log with `fold`/`tail`.
- It shows:
  - units done/total;
  - equivalence % (proven / converted);
  - coverage % (the median branch_pct and the count below 80%);
  - cost so far ("not measured" when null);
  - ETA (`eta.ts`);
  - current failures by cause, grouped as runtime missing, coverage low, not equivalent, conformance, cap, and budget.
- It never opens a browser.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The implementer inlines captured outputs | Held-out cases, read-only sealed oracle, no-op ablation, captured-literal scan (3.5). |
| The oracle under-constrains behavior | 80% branch floor, NOT PROVEN below it, witness search. The report never rounds up. |
| Text and bytes confusion in py2 to 3 | Type-tagged JSON and per-boundary declarations (section 7). |
| Nondeterministic legacy code | Double replay and declared normalizers only. Unexplained drift is NOT PROVEN. |
| The line-cap proxy is wrong | Calibrated on the pilot, plus re-slicing. |
| Remote worker compromise | Workers hold no push token, and the coordinator re-verifies every patch locally. |
| Cost blowup at 1M lines | Estimate before spend, `--budget`, per-unit caps, sonnet first. |
| The old runtime is unavailable (2.7 is end of life) | The unit is NOT PROVEN, never skipped. Documented container images supply python2.7 and JDK 8. |
| File contention with in-flight engine rows | Dependencies on E-31, E-54 and E-39 (section 13). |

## 12. Eval plan (publish everything, failures included)

**Metrics, per run:** equivalence rate, NOT PROVEN share, human touches, cost per 1K source lines, wall time, units re-sliced.

**1. Legacy-Bench pilot (M-27)**
- V10-RESEARCH cites Legacy-Bench only through a vendor report.
- The slice first confirms that a public task set exists and records its URL and license. If none exists, the pilot uses 10 public py2 and Java 8 repos under 20K lines, each with a suite, and says so.
- Gate: the equivalence rate on the pilot is published, and the sizing cap is calibrated from it.

**2. 200K-line scale test (M-28)**
- Chosen candidate: Mercurial at its last Python 2 only release, 4.x (py2 to 3).
- Criteria:
  - at least 200K source lines excluding vendored code;
  - a suite that runs headless in bounded time on the old runtime;
  - an upstream human port exists as a reference to diff against;
  - the license (GPL) allows running it.
- Why: it is a real Python 2 codebase with a large suite of its own (`run-tests.py`), and upstream later completed the Python 3 port, so a human reference exists.
- The line count is UNVERIFIED offline. M-28 measures it first with `--dry-run` inventory and `cloc`. If the count is under 200K or the suite is unbounded, the named fallback is Calibre before its Python 3 port, and the choice is recorded again.

**3. 1M lines (M-29)**
- Chosen candidate: Apache Hadoop 2.x (Java 8 to 21). It is Java 8, multi-module, and has an extensive JUnit suite.
- The line count is UNVERIFIED. It is measured the same way, with its suite run per module under the wave plan.

**Publishing:** results go to `eval/modernize/results/` and a summary to `docs/v10/METRICS.md` through the EV owner. That includes every NOT PROVEN unit and every failure.

## 13. Slice plan (M-01..M-30)

**Paths**
- `mod/` means `loki-ts/src/engine10/modernize/`.
- `T/` means `loki-ts/tests/engine10/modernize/`.
- `Wb` means `cd loki-ts && bun test`.

**Merge-time exception.** New shell tests register in `tests/run-all-tests.sh` and `tests/shard-durations.tsv`, and new modules register in `engine10/registry.ts`. The Release Manager adds those one-line registrations at merge, as with the E-32 registry lines, so no slice owns those three files.

**Shared-file dependencies**
- M-07 and M-08 touch `engine10/cli.ts` and `bin/loki`. E-31 owns both (approved, held until 03:00Z), so M-07 and M-08 depend on E-31 merging or parking. They never depend on the flip itself.
- M-14 touches `stages/wall.ts` and depends on E-54 (building).

| ID | Goal | Files | Tier | Wall check | Deps |
|---|---|---|---|---|---|
| M-01 | Modernize event types, log wrapper and state paths | mod/types.ts, mod/log.ts, T/log.test.ts | MEDIUM | Wb T/log.test.ts | none |
| M-02 | Inventory core: files, languages, build, entry points, tests | mod/inventory.ts, T/inventory.test.ts, T/fixtures/inv/ | MEDIUM | Wb T/inventory.test.ts | M-01 |
| M-03 | Python import graph via tokenize (lexes py2 source) | mod/lang/python.ts, autonomy/lib/modernize/py_imports.py, T/python_graph.test.ts | MEDIUM | Wb T/python_graph.test.ts | M-02 |
| M-04 | Java graph via jdeps, import-scan fallback recorded | mod/lang/java.ts, T/java_graph.test.ts, T/fixtures/java8/ | MEDIUM | Wb T/java_graph.test.ts | M-02 |
| M-05 | SCC clustering, 1,500-line unit cap, topological waves | mod/cluster.ts, T/cluster.test.ts | MEDIUM | Wb T/cluster.test.ts | M-02 |
| M-06 | Up-front estimate (cost, time, risk), --budget math, --dry-run print | mod/estimate.ts, T/estimate.test.ts | LOW | Wb T/estimate.test.ts | M-05 |
| M-07 | modernize CLI and flag parsing; TABLE route in engine10 cli | mod/cli.ts, loki-ts/src/engine10/cli.ts (TABLE and USAGE line only), T/cli.test.ts | MEDIUM | Wb T/cli.test.ts | M-06, E-31 merged or parked |
| M-08 | bin/loki modernize arm to engine10 regardless of default | bin/loki (modernize arm only), tests/test-modernize-dispatch.sh | MEDIUM | bash tests/test-modernize-dispatch.sh | M-07 |
| M-09 | py2/3 capture tracer with type-tagged JSON and branch coverage | autonomy/lib/modernize/py_capture.py, tests/test-modernize-py-capture.sh, tests/fixtures/modernize/py2/ | HIGH | bash tests/test-modernize-py-capture.sh | M-01 |
| M-10 | Coverage-guided input search (read-only session, plateau stop) | mod/oracle/search.ts, T/search.test.ts | HIGH | Wb T/search.test.ts | M-09 |
| M-11 | Java capture: JUnit under JDK 8 with JaCoCo plus Randoop | autonomy/lib/modernize/java_capture.sh, mod/oracle/java.ts, T/java_capture.test.ts | HIGH | Wb T/java_capture.test.ts | M-04 |
| M-12 | Oracle seal, held-out split, 80% floor, up-front NOT PROVEN | mod/oracle/seal.ts, T/oracle_seal.test.ts | HIGH | Wb T/oracle_seal.test.ts | M-09 |
| M-13 | Equivalence checker with sealed normalizers and contract output | mod/equiv.ts, T/equiv.test.ts, T/fixtures/equiv/ | HIGH | Wb T/equiv.test.ts | M-12 |
| M-14 | Wall pre-sealed mode: oracle plus conformance, green base is an error | loki-ts/src/engine10/stages/wall.ts (pre-sealed branch only), T/wall_presealed.test.ts | HIGH | Wb T/wall_presealed.test.ts | M-12, E-54 |
| M-15 | Unit runner: card to v10 run with oracle Wall and equiv check | mod/unit.ts, T/unit.test.ts | HIGH | Wb T/unit.test.ts | M-13, M-14 |
| M-16 | Deterministic codemods first (futurize, OpenRewrite) or skipped | mod/codemod.ts, T/codemod.test.ts | MEDIUM | Wb T/codemod.test.ts | M-02 |
| M-17 | Scheduler: N workers, worktrees, cascade, best-of-2, budget stop | mod/scheduler.ts, T/scheduler.test.ts | HIGH | Wb T/scheduler.test.ts | M-15 |
| M-18 | Re-slice non-equivalent units to depth 2, then NOT PROVEN | mod/reslice.ts, T/reslice.test.ts | MEDIUM | Wb T/reslice.test.ts | M-05, M-13 |
| M-19 | Strangler targets and routes.json (py2/dual/py3, per-module release) | mod/routes.ts, mod/targets/python3.ts, mod/targets/java21.ts, T/routes.test.ts | MEDIUM | Wb T/routes.test.ts | M-05 |
| M-20 | Wave verify: full build, integration and original suite | mod/wave.ts, T/wave.test.ts | MEDIUM | Wb T/wave.test.ts | M-17, M-19 |
| M-21 | Wave ship: one PR per wave with unit receipts, draft unless all proven | mod/ship.ts, T/ship.test.ts | HIGH | Wb T/ship.test.ts | M-20 |
| M-22 | Unit-level resume after coordinator crash | mod/resume.ts, T/resume.test.ts | MEDIUM | Wb T/resume.test.ts | M-17, E-39 |
| M-23 | Remote units via POST /jobs kind unit, Helm worker.engine v10, local re-verify | autonomy/trigger-server.py (unit job kind only), deploy/helm/autonomi/templates/job-worker.yaml, deploy/helm/autonomi/values.yaml, mod/remote.ts, T/remote.test.ts, tests/test-trigger-server-unit-jobs.py | HIGH | python3 tests/test-trigger-server-unit-jobs.py && Wb T/remote.test.ts | M-17 |
| M-24 | Dashboard /modernize view | loki-ts/src/engine10/dashboard/modernize.ts, loki-ts/src/engine10/dashboard/server.ts (one route), T/dashboard.test.ts | LOW | Wb T/dashboard.test.ts | M-01 |
| M-25 | Final report and verdict (COMPLETE only if all proven), sealed | mod/report.ts, T/report.test.ts | HIGH | Wb T/report.test.ts | M-13, M-21 |
| M-26 | End-to-end: py2 fixture repo modernized with stub provider | T/e2e.test.ts, T/fixtures/e2e_py2/ | MEDIUM | Wb T/e2e.test.ts | M-08, M-22, M-25 |
| M-27 | Legacy-Bench pilot harness; confirm public set; calibrate cap | eval/modernize/pilot.py, eval/modernize/test-pilot.sh | HIGH | bash eval/modernize/test-pilot.sh | M-26 |
| M-28 | 200K scale run (Mercurial 4.x, measured first, fallback Calibre) | eval/modernize/scale.py, eval/modernize/SCALE.md | HIGH | python3 eval/modernize/scale.py --target hg --dry-run-first | M-27 |
| M-29 | 1M scale run (Hadoop 2.x Java 8 to 21, measured first) | eval/modernize/scale_1m.py, eval/modernize/SCALE-1M.md | HIGH | python3 eval/modernize/scale_1m.py --dry-run-first | M-28, M-11 |
| M-30 | User docs for loki modernize, no dashes, commands match USAGE | docs/v10/GUIDE-MODERNIZE.md, tests/test-modernize-docs.sh | LOW | bash tests/test-modernize-docs.sh | M-07 |

**Critical path:** M-01 -> M-02 -> M-05 -> M-09 -> M-12 -> M-13 -> M-14 -> M-15 -> M-17 -> M-20 -> M-21 -> M-25 -> M-26 -> M-27 -> M-28.

**Parallel from the start:** M-03, M-04, M-06, M-16, M-19 and M-24 run alongside it.

**Red and green for every slice**
- Red: the test file is missing or asserts the absent behavior.
- Green: every assertion named in the goal holds.
- Each HIGH slice needs a unanimous opus review (D12).
