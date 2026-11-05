#!/usr/bin/env bash
# Builds fixtures shaped like the target Haiku misses (not the benchmark repos) and runs the scaffold on each.
# usage: fixtures.sh <root>   (root: a run-owned temp dir)
set -uo pipefail
ROOT="$1"; SP="$(cd "$(dirname "$0")" && pwd)"; DRIVE="$SP/drive.ts"
g() { git -C "$1" "${@:2}"; }
init() { mkdir -p "$1"; g "$1" init -q -b main; g "$1" config user.name t; g "$1" config user.email t@t; }
commit() { g "$1" add -A; g "$1" commit -qm "$2"; }
run() { echo "=== $1"; bun "$DRIVE" "$2" "$(g "$2" rev-parse HEAD)" "$3" ${4:-}; }

# ---- F1: changesets monorepo, code fix with test, no fragment (tq-11160 / tq-11171 shape)
mk_cs() {
  local d="$1"; init "$d"; mkdir -p "$d/.changeset" "$d/packages/core/src/__tests__" "$d/packages/devtools-internal/src"
  echo '{"name":"root","private":true}' > "$d/package.json"
  printf '{\n  // changesets\n  "changelog": "@changesets/cli/changelog",\n  "access": "public",\n  "baseBranch": "main",\n  "ignore": []\n}\n' > "$d/.changeset/config.json"
  printf -- "---\n'@acme/core': patch\n---\n\nfix(core): older fix\n" > "$d/.changeset/old-fix.md"
  echo '{"name":"@acme/core","version":"1.0.0"}' > "$d/packages/core/package.json"
  echo '{"name":"@acme/devtools-internal","private":true}' > "$d/packages/devtools-internal/package.json"
  printf 'export function result(d) {\n  return d\n}\n' > "$d/packages/core/src/observer.ts"
  printf 'export const x = 1\n' > "$d/packages/devtools-internal/src/i.ts"
  printf 'test("a", () => {})\n' > "$d/packages/core/src/__tests__/observer.test.ts"
  commit "$d" base
}
T="$ROOT/task-cs.txt"; printf 'Stale select error leaks into the next query'"'"'s pending result (#11160)\n\nWhen select throws ...\n' > "$T"
mk_cs "$ROOT/f1a"; printf 'export function result(d) {\n  if (d === undefined) return null\n  return d\n}\n' > "$ROOT/f1a/packages/core/src/observer.ts"; printf 'test("b", () => {})\n' >> "$ROOT/f1a/packages/core/src/__tests__/observer.test.ts"
run "F1a changesets: code fix, no fragment -> expect one fragment for @acme/core" "$ROOT/f1a" "$T"; cat "$ROOT"/f1a/.changeset/stale*.md 2>/dev/null
mk_cs "$ROOT/f1b"; printf 'export function result(d) { return d ?? null }\n' > "$ROOT/f1b/packages/core/src/observer.ts"; printf -- "---\n'@acme/core': patch\n---\n\nmine\n" > "$ROOT/f1b/.changeset/mine.md"
run "F1b changesets: change already has a fragment -> expect none" "$ROOT/f1b" "$T"
mk_cs "$ROOT/f1c"; printf 'test("c", () => {})\n' >> "$ROOT/f1c/packages/core/src/__tests__/observer.test.ts"
run "F1c changesets: tests only -> expect none" "$ROOT/f1c" "$T"
mk_cs "$ROOT/f1d"; printf 'export const x = 2\n' > "$ROOT/f1d/packages/devtools-internal/src/i.ts"
run "F1d changesets: private package only -> expect none" "$ROOT/f1d" "$T"

# ---- F2: Go systematic rewrite, 2 of 3 named sites (cli-2478 shape)
mk_go() {
  local d="$1"; init "$d"
  printf 'module example.com/errs\n\ngo 1.22\n' > "$d/go.mod"
  cat > "$d/errors.go" <<'GO'
package errs

import (
	"fmt"
	"io"
	"os"
)

var ErrWriter io.Writer = os.Stderr
var OsExiter = func(code int) {}

type ExitCoder interface {
	error
	ExitCode() int
}

type ErrorFormatter interface{ Format(s fmt.State, verb rune) }

type MultiError interface {
	error
	Errors() []error
}

type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }
func (e *exitError) ExitCode() int { return e.code }

type multiError []error

func (m multiError) Error() string   { return "multiple errors" }
func (m multiError) Errors() []error { return m }

func Exit(msg string, code int) ExitCoder { return &exitError{code: code, msg: msg} }

func HandleExitCoder(err error) {
	if err == nil {
		return
	}

	if exitErr, ok := err.(ExitCoder); ok {
		if msg := err.Error(); msg != "" {
			if _, ok := exitErr.(ErrorFormatter); ok {
				_, _ = fmt.Fprintf(ErrWriter, "%+v\n", err)
			} else {
				_, _ = fmt.Fprintln(ErrWriter, err)
			}
		}
		OsExiter(exitErr.ExitCode())
		return
	}

	if multiErr, ok := err.(MultiError); ok {
		code := handleMultiError(multiErr)
		OsExiter(code)
		return
	}
}

func handleMultiError(multiErr MultiError) int {
	code := 1
	for _, merr := range multiErr.Errors() {
		if multiErr2, ok := merr.(MultiError); ok {
			code = handleMultiError(multiErr2)
		} else if merr != nil {
			fmt.Fprintln(ErrWriter, merr)
			if exitErr, ok := merr.(ExitCoder); ok {
				code = exitErr.ExitCode()
			}
		}
	}
	return code
}
GO
  commit "$d" base
}
haiku_partial() { # what the Haiku run did: errors.As for the two ExitCoder sites only, plus its own test
  local f="$1/errors.go"
  perl -0pi -e 's/import \(\n/import (\n\t"errors"\n/; s/\tif exitErr, ok := err\.\(ExitCoder\); ok \{/\tvar exitErr ExitCoder\n\tif errors.As(err, &exitErr) {/; s/\t\t\tif exitErr, ok := merr\.\(ExitCoder\); ok \{/\t\t\tvar exitErr ExitCoder\n\t\t\tif errors.As(merr, &exitErr) {/' "$f"
  cat > "$1/errors_test.go" <<'GO'
package errs

import (
	"bytes"
	"fmt"
	"testing"
)

func capture(t *testing.T) (*bytes.Buffer, *int) {
	b := &bytes.Buffer{}
	code := -1
	ErrWriter = b
	OsExiter = func(c int) { code = c }
	return b, &code
}

func TestWrappedExit(t *testing.T) {
	_, code := capture(t)
	HandleExitCoder(fmt.Errorf("ctx: %w", Exit("boom", 3)))
	if *code != 3 {
		t.Fatalf("code %d", *code)
	}
}
GO
}
T2="$ROOT/task-go.txt"; cat > "$T2" <<'TXT'
HandleExitCoder does not see an ExitCoder or MultiError wrapped with %w

HandleExitCoder looks for an `ExitCoder` (and for a `MultiError`) with a bare type assertion, so an error
wrapped with fmt.Errorf("...: %w", err) is not recognized. Use errors.As.
TXT
mk_go "$ROOT/f2a"; haiku_partial "$ROOT/f2a"
( cd "$ROOT/f2a" && timeout 120 go build ./... && echo "f2a builds before scaffold" )
run "F2a go: 2 of 3 named sites rewritten -> expect MultiError site(s) rewritten" "$ROOT/f2a" "$T2"
g "$ROOT/f2a" diff --stat; g "$ROOT/f2a" diff -U1 -- errors.go | sed -n '1,200p' | grep -E '^[-+]' | grep -v '^+++\|^---'
cat >> "$ROOT/f2a/errors_test.go" <<'GO'

func TestWrappedMultiError(t *testing.T) {
	_, code := capture(t)
	HandleExitCoder(fmt.Errorf("ctx: %w", multiError{Exit("a", 4)}))
	if *code != 4 {
		t.Fatalf("wrapped MultiError not handled, code %d", *code)
	}
}
GO
( cd "$ROOT/f2a" && timeout 180 go vet ./... && timeout 180 go test ./... 2>&1 | tail -5 )

mk_go "$ROOT/f2b"; haiku_partial "$ROOT/f2b"; printf 'HandleExitCoder does not see an ExitCoder wrapped with %%w\n' > "$ROOT/task-go-b.txt"
run "F2b go: task never names MultiError -> expect no rewrite" "$ROOT/f2b" "$ROOT/task-go-b.txt" --dry
mk_go "$ROOT/f2c"; perl -0pi -e 's/import \(\n/import (\n\t"errors"\n/; s/\tif exitErr, ok := err\.\(ExitCoder\); ok \{/\tvar exitErr ExitCoder\n\tif errors.As(err, &exitErr) {/' "$ROOT/f2c/errors.go"
run "F2c go: only one instance rewritten (no rule) -> expect no rewrite" "$ROOT/f2c" "$T2" --dry

# ---- F3: sibling argument (cli-2418 shape), detect only
init "$ROOT/f3"; cat > "$ROOT/f3/parse.go" <<'GO'
package p

import "strings"

func parse(rargs []string) []string {
	var posArgs []string
	for len(rargs) > 0 {
		firstArg := strings.TrimSpace(rargs[0])
		if firstArg == "--" {
			posArgs = append(posArgs, rargs[1:]...)
			break
		}
		if firstArg == "-" {
			posArgs = append(posArgs, firstArg)
			break
		}
		if !strings.HasPrefix(firstArg, "-") {
			posArgs = append(posArgs, rargs[0])
			rargs = rargs[1:]
			continue
		}
		rargs = rargs[1:]
	}
	return posArgs
}
GO
commit "$ROOT/f3" base; perl -0pi -e 's/(append\(posArgs, firstArg\)\n\t\t\t)break/$1rargs = rargs[1:]\n\t\t\tcontinue/' "$ROOT/f3/parse.go"
printf 'a lone "-" drops every argument after it\n' > "$ROOT/task-f3.txt"
run "F3 go: break->continue next to a normalized append -> expect a sibling note" "$ROOT/f3" "$ROOT/task-f3.txt" --dry

# ---- F4: TS false-positive guard: rule whose added literal is derived from the old name
init "$ROOT/f4"; cat > "$ROOT/f4/h.ts" <<'TS'
export function h(err: unknown) {
  if (err instanceof HttpError) {
    return 1
  }
  if (err instanceof HttpError) {
    return 2
  }
  if (err instanceof TimeoutError) {
    return 3
  }
}
TS
commit "$ROOT/f4" base; perl -pi -e 's/err instanceof HttpError/isHttpError(err)/' "$ROOT/f4/h.ts"
printf 'handle HttpError and TimeoutError across realms\n' > "$ROOT/task-f4.txt"
run "F4 ts: candidate's differing name would be dropped -> expect no rewrite" "$ROOT/f4" "$ROOT/task-f4.txt" --dry

# ---- F5: towncrier python
init "$ROOT/f5"; mkdir -p "$ROOT/f5/newsfragments" "$ROOT/f5/pkg"
printf '[project]\nname="pkg"\n\n[tool.towncrier]\ndirectory = "newsfragments"\n' > "$ROOT/f5/pyproject.toml"; touch "$ROOT/f5/newsfragments/.gitkeep"
printf 'def f():\n    return 1\n' > "$ROOT/f5/pkg/m.py"; commit "$ROOT/f5" base; printf 'def f():\n    return 2\n' > "$ROOT/f5/pkg/m.py"
printf 'f returns the wrong value (#42)\n' > "$ROOT/task-f5.txt"
run "F5 towncrier: expect newsfragments/42.bugfix.md" "$ROOT/f5" "$ROOT/task-f5.txt"; cat "$ROOT/f5/newsfragments/42.bugfix.md" 2>/dev/null

# ---- U: undo if the first verify regresses, through the real engine (bin/loki from source) on the stub provider.
# SCAFFOLD_ENGINE=1 runs these legs. Each leg's implement session copies a prepared partial edit (the shape Haiku leaves);
# every other session is the shared e2e stub. U1: the completion is right (kept, verify green, no fix round). U2: the
# completion is wrong (a site the task excludes): the first verify fails, the model's own tree passes, the rewrite is undone.
# U3: the completion is right but another failure remains: the model's tree fails the same check, so the rewrite is kept.
if [ "${SCAFFOLD_ENGINE:-0}" = "1" ]; then
REPO_ROOT="$(cd "$SP/../../../.." && pwd)"; E2E="$REPO_ROOT/tests/min/fixtures/e2e/bin/claude"
mkstub() { # mkstub <leg dir> <prepared dir>: implement copies the prepared files over the repo, other stages go to the e2e stub
  cat > "$1/stub-claude" <<SH
#!/usr/bin/env bash
[ "\${LOKI_E10_STAGE:-}" = "fix" ] || for a in "\$@"; do case "\$a" in *"Loki 10 implement stage"*) cp -R "$2"/. .; echo LOKI_DONE; exit 0 ;; esac; done # a fix session (its brief repeats the implement marker) does nothing
exec "$E2E" "\$@"
SH
  chmod +x "$1/stub-claude"; }
engine() { # engine <leg dir> <task>: one run in <leg>/repo; prints rc, outcome, scaffold events and fix rounds
  local d="$1"
  ( cd "$d/repo" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_TS_ENTRY -u LOKI_RECEIPT_SIGNING_KEY \
      BUN_FROM_SOURCE=1 LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$d/stub-claude" LOKI_E10_PLAN=0 LOKI_E10_SCAFFOLD=1 LOKI_E10_SCAFFOLD_SYSTEMATIC=1 \
      LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" E2E_STUB_LOG="$d/stub.log" timeout 600 bash "$REPO_ROOT/bin/loki" "$2" --no-pr > "$d/engine.out" 2>&1
    echo "rc=$?" )
  local ev; ev="$(ls "$d"/repo/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
  echo "outcome: $(sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' "$d/engine.out" | head -1)"
  echo "scaffold events: $(grep -o '"type":"scaffold\.[a-z]*"' "$ev" | tr '\n' ' ')"
  echo "fix rounds: $(grep -c '"type":"fix.round"' "$ev")  verify runs: $(grep -c '"type":"stage.completed","stage":"verify"' "$ev")"
  grep -o '"type":"scaffold.undone"[^}]*}[^}]*}' "$ev" | head -1
}
# U2 shape: two of three trim-only helpers start lowercasing; the third must keep the caller's case.
mk_names() { # mk_names <leg dir>
  local d="$1"; init "$d/repo"; printf 'module example.com/names\n\ngo 1.22\n' > "$d/repo/go.mod"
  cat > "$d/repo/names.go" <<'GO'
package names

import "strings"

// Name is the display name.
func Name(s string) string { return strings.TrimSpace(s) }

// Label is the label text.
func Label(s string) string { return strings.TrimSpace(s) }

// Raw keeps the caller's case: trimmed only.
func Raw(s string) string { return strings.TrimSpace(s) }
GO
  cat > "$d/repo/names_test.go" <<'GO'
package names

import "testing"

func TestRaw(t *testing.T) {
	if got := Raw(" AbC "); got != "AbC" {
		t.Fatalf("Raw lost the caller's case: %q", got)
	}
}
GO
  commit "$d/repo" base
  mkdir -p "$d/prep"; sed -e 's/^func Name(s string) string { return strings.TrimSpace(s) }/func Name(s string) string { return strings.ToLower(strings.TrimSpace(s)) }/' \
    -e 's/^func Label(s string) string { return strings.TrimSpace(s) }/func Label(s string) string { return strings.ToLower(strings.TrimSpace(s)) }/' "$d/repo/names.go" > "$d/prep/names.go"
  { cat "$d/repo/names_test.go"; printf '\nfunc TestNameLabelLower(t *testing.T) {\n\tif Name(" AbC ") != "abc" || Label(" X ") != "x" {\n\t\tt.Fatal("not lowercased")\n\t}\n}\n'; } > "$d/prep/names_test.go"
}
# U1 and U3 shape: the F2 errors.go with Haiku's 2-of-3 errors.As edit and a visible wrapped-MultiError test.
mk_errs_leg() { # mk_errs_leg <leg dir> [extra failing test: 1]
  local d="$1"; mk_go "$d/repo"; mkdir -p "$d/prep"; cp "$d/repo/errors.go" "$d/prep/errors.go"
  ( cd "$d" && mkdir -p tmp && cp prep/errors.go tmp/errors.go && haiku_partial tmp >/dev/null 2>&1; cp tmp/errors.go prep/errors.go; cp tmp/errors_test.go prep/errors_test.go; rm -rf tmp )
  cat >> "$d/prep/errors_test.go" <<'GO'

func TestWrappedMultiError(t *testing.T) {
	_, code := capture(t)
	HandleExitCoder(fmt.Errorf("ctx: %w", multiError{Exit("a", 4)}))
	if *code != 4 {
		t.Fatalf("wrapped MultiError not handled, code %d", *code)
	}
}
GO
  if [ "${2:-}" = "1" ]; then printf '\nfunc TestExitMessage(t *testing.T) {\n\tif Exit("boom", 3).Error() != "exit 3: boom" {\n\t\tt.Fatal("message format")\n\t}\n}\n' >> "$d/prep/errors_test.go"; fi
}
committed() { git -C "$1/repo" show "$(git -C "$1/repo" for-each-ref --format='%(refname:short)' refs/heads/loki | head -1):$2"; } # the run's committed loki/<run> tree
TASK_NAMES="Name and Label should lower-case their result (Raw keeps the caller's case)"
for leg in u1 u2 u3; do mkdir -p "$ROOT/$leg"; done
mk_errs_leg "$ROOT/u1"; mkstub "$ROOT/u1" "$ROOT/u1/prep"
echo "=== U1 engine: right completion -> scaffold.applied, no undo, verify green, 0 fix rounds"; engine "$ROOT/u1" "$(head -1 "$T2")"
committed "$ROOT/u1" errors.go | grep -c 'errors.As(err, &multiErr)' | sed 's/^/U1 multiErr rewrite in the committed tree: /'
mk_names "$ROOT/u2"; mkstub "$ROOT/u2" "$ROOT/u2/prep"
echo "=== U2 engine: wrong completion (Raw) -> first verify red, model tree green, scaffold.undone, 0 fix rounds"; engine "$ROOT/u2" "$TASK_NAMES"
committed "$ROOT/u2" names.go | grep -c 'func Raw(s string) string { return strings.TrimSpace(s) }' | sed 's/^/U2 Raw left as the model wrote it in the committed tree: /'
mk_errs_leg "$ROOT/u3" 1; mkstub "$ROOT/u3" "$ROOT/u3/prep"
echo "=== U3 engine: right completion, another failure remains -> no undo (re-applied), fix rounds follow"; engine "$ROOT/u3" "$(head -1 "$T2")"
committed "$ROOT/u3" errors.go | grep -c 'errors.As(err, &multiErr)' | sed 's/^/U3 multiErr rewrite kept in the committed tree: /'
fi
