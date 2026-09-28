#!/usr/bin/env bash
# autonomy/lib/modernize/java_capture.sh -- M-11: Java 8 to 21 oracle capture
# (docs/v10/MODERNIZE.md sections 3.2 and 7: "Run the existing JUnit suite
# under JDK 8 with the JaCoCo agent. Add Randoop-generated regression tests
# per unit class ... Cases record the method, serialized arguments ..., the
# return value, the exception class and stdout.").
#
# Split (loki-ts/src/engine10/modernize/oracle/java.ts does every verdict):
# this script only runs tools and dumps RAW artifacts into --out:
#   status.json     -- what was detected: JDK 8 or not, jacoco/randoop jars
#   jacoco.xml       -- JaCoCo's own XML report (untouched, so java.ts can
#                        parse the real schema instead of a shape this script
#                        invents)
#   replay1.jsonl    -- one CaptureRunner run's raw case records
#   replay2.jsonl    -- a second, independent run of the same cases
# java.ts applies the double-replay determinism filter, the boundary check,
# coverage floor and NOT PROVEN reasons -- never this script. This script
# never claims a case is proven or a coverage number is final.
#
# CaptureRunner (embedded below as a heredoc, compiled once per call) does
# the actual reflection: it walks each unit class's public methods and
# invokes the capturable ones (primitives, String, List/Set/Map only --
# ponytail: no attempt to construct arbitrary objects or to replay Randoop's
# literal call sequences, which would need parsing generated Java source;
# upgrade path is Randoop's library API (randoop.sequence.Sequence) once a
# JDK 8 + Randoop jar host exists to build and test it against). A method
# whose parameter or return type falls outside that set gets ONE case record
# with a "not_capturable" reason and no invocation -- capture never guesses.
#
# Every branch below is exercised in loki-ts/tests/engine10/modernize/
# java_capture.test.ts with a stubbed PATH (fake java/javac/jacoco/randoop),
# because this repo has no JDK 8, JaCoCo or Randoop jar to run for real.
set -uo pipefail

usage() {
    echo "usage: java_capture.sh --unit-dir DIR --classes FQCN[,FQCN...] --out DIR" \
         "[--files REL.java[,REL.java...]] [--jacoco-agent JAR] [--jacoco-cli JAR]" \
         "[--randoop-jar JAR] [--test-classpath CP] [--randoop-time-limit SECS]" >&2
}

UNIT_DIR=""
CLASSES=""
OUT_DIR=""
FILES_ARG=""
JACOCO_AGENT="${LOKI_MOD_JACOCO_AGENT:-}"
JACOCO_CLI="${LOKI_MOD_JACOCO_CLI:-}"
RANDOOP_JAR="${LOKI_MOD_RANDOOP_JAR:-}"
TEST_CLASSPATH=""
RANDOOP_TIME_LIMIT="20"

while [ $# -gt 0 ]; do
    case "$1" in
        --unit-dir) UNIT_DIR="$2"; shift 2 ;;
        --classes) CLASSES="$2"; shift 2 ;;
        --files) FILES_ARG="$2"; shift 2 ;;
        --out) OUT_DIR="$2"; shift 2 ;;
        --jacoco-agent) JACOCO_AGENT="$2"; shift 2 ;;
        --jacoco-cli) JACOCO_CLI="$2"; shift 2 ;;
        --randoop-jar) RANDOOP_JAR="$2"; shift 2 ;;
        --test-classpath) TEST_CLASSPATH="$2"; shift 2 ;;
        --randoop-time-limit) RANDOOP_TIME_LIMIT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "java_capture.sh: unknown arg: $1" >&2; usage; exit 2 ;;
    esac
done

if [ -z "$UNIT_DIR" ] || [ -z "$CLASSES" ] || [ -z "$OUT_DIR" ]; then
    usage
    exit 2
fi

mkdir -p "$OUT_DIR" || { echo "java_capture.sh: cannot create --out $OUT_DIR" >&2; exit 2; }

REASONS=()
# JSON string escaping: backslash, double quote, then every C0 control character (0x00-0x1F).
# \n \r \t get their short escapes; the rest (e.g. a stray 0x01 or 0x1B in a user-set
# LOKI_MOD_JACOCO_AGENT/RANDOOP_JAR path, or an unusual `java -version` line) become \u00XX so
# status.json is always valid JSON no matter what these values contain. 0x00 is not handled --
# a bash/env-var string cannot carry a literal NUL byte, so it is unreachable here.
json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\n'/\\n}"
    local i c esc
    for i in {1..31}; do
        case "$i" in 9|10|13) continue ;; esac
        c=$(printf '%b' "\\$(printf '%03o' "$i")")
        esc=$(printf '\\u%04x' "$i")
        s="${s//$c/$esc}"
    done
    printf '%s' "$s"
}

write_status() {
    local jdk8="$1" jdk_raw="$2"
    local reasons_json="[]"
    if [ "${#REASONS[@]}" -gt 0 ]; then
        reasons_json="["
        local first=1
        for r in "${REASONS[@]}"; do
            [ "$first" -eq 1 ] || reasons_json+=","
            reasons_json+="\"$(json_escape "$r")\""
            first=0
        done
        reasons_json+="]"
    fi
    cat > "$OUT_DIR/status.json" <<EOF
{"jdk8":$jdk8,"jdkVersionRaw":$([ -n "$jdk_raw" ] && echo "\"$(json_escape "$jdk_raw")\"" || echo null),"jacocoAgent":$([ -n "$JACOCO_AGENT" ] && echo "\"$(json_escape "$JACOCO_AGENT")\"" || echo null),"jacocoCli":$([ -n "$JACOCO_CLI" ] && echo "\"$(json_escape "$JACOCO_CLI")\"" || echo null),"randoopJar":$([ -n "$RANDOOP_JAR" ] && echo "\"$(json_escape "$RANDOOP_JAR")\"" || echo null),"reasons":$reasons_json}
EOF
}

# --- 1. JDK 8 detection --------------------------------------------------
# A bare `command -v java` succeeds on macOS even with no JDK installed (the
# /usr/bin/java stub). The only reliable signal is `java -version`'s STDOUT
# (not stderr -- that varies by vendor/newer JDKs; javac/java both print the
# version string to stdout as of JDK 10+, and to stderr on 8/9 -- so check
# both streams rather than assume one).
if ! command -v java >/dev/null 2>&1; then
    REASONS+=("skipped: no JDK 8" "old runtime unavailable: java not found on PATH")
    write_status false ""
    : > "$OUT_DIR/replay1.jsonl"
    : > "$OUT_DIR/replay2.jsonl"
    : > "$OUT_DIR/jacoco.xml"
    exit 0
fi

JAVA_VER_OUT="$(java -version 2>&1)"
JDK8=false
if printf '%s' "$JAVA_VER_OUT" | grep -qE '"(1\.8\.|8\.)'; then
    JDK8=true
fi

if [ "$JDK8" != "true" ]; then
    REASONS+=("skipped: no JDK 8" "old runtime unavailable: detected $(printf '%s' "$JAVA_VER_OUT" | head -1)")
    write_status false "$JAVA_VER_OUT"
    : > "$OUT_DIR/replay1.jsonl"
    : > "$OUT_DIR/replay2.jsonl"
    : > "$OUT_DIR/jacoco.xml"
    exit 0
fi

# --- 2. Compile the unit -------------------------------------------------
CLASSES_DIR="$OUT_DIR/classes"
mkdir -p "$CLASSES_DIR"
# The unit's own file list (--files, repo-relative to --unit-dir) is authoritative when given --
# oracle/java.ts always passes it, built from the merged M-04 graph, so only the unit's actual
# files ever get compiled here. Without it (a direct CLI call), every .java under --unit-dir is
# used, which is only correct when --unit-dir IS the unit (never a shared multi-unit checkout).
if [ -n "$FILES_ARG" ]; then
    JAVA_FILES=$(printf '%s' "$FILES_ARG" | tr ',' '\n' | sed "s#^#${UNIT_DIR}/#" | tr '\n' ' ')
else
    JAVA_FILES=$(find "$UNIT_DIR" -name '*.java' 2>/dev/null)
fi
if [ -z "$JAVA_FILES" ]; then
    REASONS+=("no .java files found under --unit-dir")
    write_status true "$JAVA_VER_OUT"
    : > "$OUT_DIR/replay1.jsonl"
    : > "$OUT_DIR/replay2.jsonl"
    : > "$OUT_DIR/jacoco.xml"
    exit 0
fi
# shellcheck disable=SC2086
if ! javac -d "$CLASSES_DIR" -cp "$TEST_CLASSPATH" $JAVA_FILES > "$OUT_DIR/javac.log" 2>&1; then
    REASONS+=("javac failed: see javac.log")
    write_status true "$JAVA_VER_OUT"
    : > "$OUT_DIR/replay1.jsonl"
    : > "$OUT_DIR/replay2.jsonl"
    : > "$OUT_DIR/jacoco.xml"
    exit 0
fi

# --- 3. Existing JUnit suite under the JaCoCo agent (coverage only) -----
# ponytail: not run. java_capture.sh only receives the unit's production FQCNs (--classes) --
# never which of them are JUnit test classes, because M-04/M-05 do not yet tag test files
# separately from production files in the unit graph. Running JUnitCore against the production
# classes (the previous behaviour here) executed no actual tests and silently mislabeled
# coverage as measuring the existing suite, so it is removed rather than kept wrong. Upgrade
# path: once the unit graph distinguishes test files, thread their FQCNs through as their own
# flag and run JUnitCore on those (not $CLASSES), under this same agent, before CaptureRunner.
EXEC_FILE="$OUT_DIR/jacoco.exec"
REASONS+=("existing JUnit suite not run: no test classes given to java_capture.sh")
if [ -z "$JACOCO_AGENT" ] || [ ! -f "$JACOCO_AGENT" ]; then
    REASONS+=("jacoco agent not available: coverage not measured")
fi

# --- 4. Randoop regression tests: generated, compiled, smoke-run --------
# Randoop's own generated tests are run to confirm they compile and pass, but NOT under the
# jacoco agent: their branches are not yet turned into oracle cases (see the CaptureRunner
# comment below), so counting their coverage into EXEC_FILE would let branch_pct clear the 80%
# floor on branches cases.jsonl does not actually cover -- the exact failure this slice's review
# reproduced. ponytail: parsing Randoop's generated call sequences into cases.jsonl via the
# double replay (section 7) is not implemented; upgrade path is Randoop's library API
# (randoop.sequence.Sequence) once a JDK 8 + Randoop jar host exists to build against.
if [ -n "$RANDOOP_JAR" ] && [ -f "$RANDOOP_JAR" ]; then
    RANDOOP_OUT="$OUT_DIR/randoop-tests"
    mkdir -p "$RANDOOP_OUT"
    RANDOOP_TESTCLASS_ARGS=()
    IFS=',' read -ra RANDOOP_CLASS_LIST <<< "$CLASSES"
    for rc in "${RANDOOP_CLASS_LIST[@]}"; do
        RANDOOP_TESTCLASS_ARGS+=("--testclass=$rc")
    done
    (cd "$RANDOOP_OUT" && java -cp "${RANDOOP_JAR}:${CLASSES_DIR}" randoop.main.Main gentests \
        "${RANDOOP_TESTCLASS_ARGS[@]}" \
        --time-limit="$RANDOOP_TIME_LIMIT" \
        --junit-output-dir="$RANDOOP_OUT" \
        --regression-test-basename=RandoopRegression \
        > "$OUT_DIR/randoop.log" 2>&1) || REASONS+=("randoop exited non-zero: see randoop.log")
    RANDOOP_JAVA=$(find "$RANDOOP_OUT" -name '*.java' 2>/dev/null)
    if [ -n "$RANDOOP_JAVA" ]; then
        # shellcheck disable=SC2086
        if javac -d "$CLASSES_DIR" -cp "${RANDOOP_JAR}:${CLASSES_DIR}" $RANDOOP_JAVA \
            > "$OUT_DIR/randoop-javac.log" 2>&1; then
            RANDOOP_CLASSES=$(cd "$RANDOOP_OUT" && find . -name '*.java' | sed 's#^\./##; s#\.java$##; s#/#.#g' | tr '\n' ' ')
            # shellcheck disable=SC2086
            java -cp "${CLASSES_DIR}:${RANDOOP_JAR}" org.junit.runner.JUnitCore \
                $RANDOOP_CLASSES > "$OUT_DIR/junit-randoop.log" 2>&1 || true
            REASONS+=("randoop tests generated and run but not yet added as oracle cases: double-replay of generated sequences not implemented")
        else
            REASONS+=("randoop-generated tests failed to compile: see randoop-javac.log")
        fi
    else
        REASONS+=("randoop produced no regression tests")
    fi
else
    REASONS+=("randoop jar not available: no generated regression tests")
fi

# --- 5. CaptureRunner: reflective double replay (coverage source) -------
RUNNER_SRC="$OUT_DIR/CaptureRunner.java"
cat > "$RUNNER_SRC" <<'JAVA_EOF'
import java.lang.reflect.*;
import java.io.*;
import java.util.*;

/** M-11 embedded capture runner: for each given class, invokes every public
 *  capturable method (primitives/wrappers, String, List/Set/Map params and
 *  return only) with one canned argument per parameter, and writes one JSON
 *  case record per method to the given output file. A method outside that
 *  type set gets a not_capturable record with no invocation -- never guessed. */
public final class CaptureRunner {
    static final Set<Class<?>> SCALAR = new HashSet<Class<?>>(Arrays.asList(
        boolean.class, Boolean.class, byte.class, Byte.class, short.class, Short.class,
        int.class, Integer.class, long.class, Long.class, float.class, Float.class,
        double.class, Double.class, char.class, Character.class, String.class));

    static boolean capturable(Class<?> t) {
        if (t == void.class || t == Void.class) return true;
        if (SCALAR.contains(t)) return true;
        return List.class.isAssignableFrom(t) || Set.class.isAssignableFrom(t) || Map.class.isAssignableFrom(t);
    }

    static Object canned(Class<?> t) {
        if (t == boolean.class || t == Boolean.class) return Boolean.TRUE;
        if (t == byte.class || t == Byte.class) return (byte) 1;
        if (t == short.class || t == Short.class) return (short) 1;
        if (t == int.class || t == Integer.class) return 1;
        if (t == long.class || t == Long.class) return 1L;
        if (t == float.class || t == Float.class) return 1.0f;
        if (t == double.class || t == Double.class) return 1.0d;
        if (t == char.class || t == Character.class) return 'a';
        if (t == String.class) return "a";
        if (List.class.isAssignableFrom(t)) return new ArrayList<Object>();
        if (Set.class.isAssignableFrom(t)) return new TreeSet<Object>();
        if (Map.class.isAssignableFrom(t)) return new TreeMap<Object, Object>();
        return null;
    }

    static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c == '\n') b.append("\\n");
            else if (c == '\r') b.append("\\r");
            else if (c == '\t') b.append("\\t");
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.toString();
    }

    static String tag(Object v) {
        if (v == null) return "{\"t\":\"none\"}";
        if (v instanceof Boolean) return "{\"t\":\"bool\",\"v\":" + v + "}";
        if (v instanceof Byte || v instanceof Short || v instanceof Integer || v instanceof Long) {
            return "{\"t\":\"int\",\"v\":\"" + v + "\"}";
        }
        if (v instanceof Float || v instanceof Double) {
            double d = ((Number) v).doubleValue();
            String s = Double.isNaN(d) ? "\"nan\"" : Double.isInfinite(d) ? (d > 0 ? "\"inf\"" : "\"-inf\"") : String.valueOf(d);
            return "{\"t\":\"float\",\"v\":" + s + "}";
        }
        if (v instanceof Character) return "{\"t\":\"text\",\"v\":\"" + esc(String.valueOf(v)) + "\"}";
        if (v instanceof String) return "{\"t\":\"text\",\"v\":\"" + esc((String) v) + "\"}";
        if (v instanceof List || v instanceof Set) {
            StringBuilder b = new StringBuilder("{\"t\":\"list\",\"v\":[");
            boolean first = true;
            for (Object o : (Iterable<?>) v) {
                if (!first) b.append(",");
                b.append(tag(o));
                first = false;
            }
            return b.append("]}").toString();
        }
        if (v instanceof Map) {
            StringBuilder b = new StringBuilder("{\"t\":\"dict\",\"v\":[");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) b.append(",");
                b.append("[").append(tag(e.getKey())).append(",").append(tag(e.getValue())).append("]");
                first = false;
            }
            return b.append("]}").toString();
        }
        return "{\"t\":\"unsupported\",\"type\":\"" + esc(v.getClass().getName()) + "\"}";
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: CaptureRunner <out.jsonl> <FQCN>[,FQCN...]");
            System.exit(2);
        }
        PrintWriter out = new PrintWriter(new FileWriter(args[0]));
        for (String fqcn : args[1].split(",")) {
            Class<?> cls;
            try {
                cls = Class.forName(fqcn);
            } catch (Throwable t) {
                out.println("{\"class\":\"" + esc(fqcn) + "\",\"method\":null,\"not_capturable\":[\"boundary:class " + esc(fqcn) + " failed to load\"]}");
                continue;
            }
            Object instance = null;
            boolean hasCtor = false;
            try {
                Constructor<?> c = cls.getDeclaredConstructor();
                hasCtor = Modifier.isPublic(c.getModifiers());
            } catch (Throwable ignored) {
                hasCtor = false;
            }
            for (Method m : cls.getDeclaredMethods()) {
                if (!Modifier.isPublic(m.getModifiers()) || m.isSynthetic() || m.isBridge()) continue;
                Class<?>[] ptypes = m.getParameterTypes();
                // Signature includes each parameter's simple type name, not just the count --
                // same-name overloads with equal arity (add(int,int) vs add(String,String))
                // would otherwise collide into one downstream map key and silently drop a case.
                StringBuilder sigParams = new StringBuilder();
                for (int i = 0; i < ptypes.length; i++) {
                    if (i > 0) sigParams.append(",");
                    sigParams.append(ptypes[i].getSimpleName());
                }
                String sig = fqcn + "#" + m.getName() + "(" + sigParams + ")";
                boolean okParams = true;
                for (Class<?> p : ptypes) if (!capturable(p)) okParams = false;
                boolean okReturn = capturable(m.getReturnType());
                boolean staticOk = Modifier.isStatic(m.getModifiers()) || hasCtor;
                if (!okParams || !okReturn || !staticOk) {
                    String reason = !staticOk ? "no public zero-arg constructor" : "parameter or return type not capturable";
                    out.println("{\"class\":\"" + esc(fqcn) + "\",\"method\":\"" + esc(sig) + "\",\"not_capturable\":[\"boundary:" + esc(reason) + "\"]}");
                    continue;
                }
                Object[] callArgs = new Object[ptypes.length];
                for (int i = 0; i < ptypes.length; i++) callArgs[i] = canned(ptypes[i]);
                if (instance == null && !Modifier.isStatic(m.getModifiers())) {
                    try {
                        Constructor<?> c = cls.getDeclaredConstructor();
                        c.setAccessible(true);
                        instance = c.newInstance();
                    } catch (Throwable t) {
                        out.println("{\"class\":\"" + esc(fqcn) + "\",\"method\":\"" + esc(sig) + "\",\"not_capturable\":[\"boundary:constructor threw\"]}");
                        continue;
                    }
                }
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                PrintStream prevOut = System.out;
                Object ret = null;
                Throwable exc = null;
                try {
                    System.setOut(new PrintStream(buf, true, "UTF-8"));
                    m.setAccessible(true);
                    ret = m.invoke(Modifier.isStatic(m.getModifiers()) ? null : instance, callArgs);
                } catch (InvocationTargetException e) {
                    exc = e.getCause() != null ? e.getCause() : e;
                } catch (Throwable t) {
                    exc = t;
                } finally {
                    System.setOut(prevOut);
                }
                StringBuilder argsJson = new StringBuilder("[");
                for (int i = 0; i < callArgs.length; i++) {
                    if (i > 0) argsJson.append(",");
                    argsJson.append(tag(callArgs[i]));
                }
                argsJson.append("]");
                String stdout = buf.toString("UTF-8");
                String excJson = exc == null ? "null" : "{\"type\":\"" + esc(exc.getClass().getName()) + "\"}";
                String retJson = exc == null ? tag(ret) : "null";
                out.println("{\"class\":\"" + esc(fqcn) + "\",\"method\":\"" + esc(sig) + "\",\"args\":" + argsJson
                    + ",\"return\":" + retJson + ",\"exc\":" + excJson + ",\"stdout\":\"" + esc(stdout) + "\",\"not_capturable\":[]}");
            }
        }
        out.close();
    }
}
JAVA_EOF

if javac -d "$OUT_DIR" "$RUNNER_SRC" > "$OUT_DIR/runner-javac.log" 2>&1; then
    # Only replay1 carries the jacoco agent: branch_pct must measure exactly the run that
    # produced cases.jsonl, never a second, redundant pass -- replay2 exists purely for the
    # determinism check above, not for coverage.
    if [ -n "$JACOCO_AGENT" ] && [ -f "$JACOCO_AGENT" ]; then
        java "-javaagent:${JACOCO_AGENT}=destfile=${EXEC_FILE},append=true" \
            -cp "${OUT_DIR}:${CLASSES_DIR}" CaptureRunner "$OUT_DIR/replay1.jsonl" "$CLASSES" \
            > "$OUT_DIR/replay1.log" 2>&1 || REASONS+=("CaptureRunner replay 1 exited non-zero")
    else
        java -cp "${OUT_DIR}:${CLASSES_DIR}" CaptureRunner "$OUT_DIR/replay1.jsonl" "$CLASSES" \
            > "$OUT_DIR/replay1.log" 2>&1 || REASONS+=("CaptureRunner replay 1 exited non-zero")
    fi
    java -cp "${OUT_DIR}:${CLASSES_DIR}" CaptureRunner "$OUT_DIR/replay2.jsonl" "$CLASSES" \
        > "$OUT_DIR/replay2.log" 2>&1 || REASONS+=("CaptureRunner replay 2 exited non-zero")
else
    REASONS+=("CaptureRunner failed to compile: see runner-javac.log")
    : > "$OUT_DIR/replay1.jsonl"
    : > "$OUT_DIR/replay2.jsonl"
fi

# --- 6. JaCoCo XML report (raw, untouched -- java.ts parses it) ---------
# Runs after CaptureRunner so EXEC_FILE (written above, replay1 only) is complete before the
# report is built from it -- generating the report before the coverage-producing run even
# happened (the previous ordering here) always reported empty or stale coverage.
if [ -n "$JACOCO_CLI" ] && [ -f "$JACOCO_CLI" ] && [ -f "$EXEC_FILE" ]; then
    java -jar "$JACOCO_CLI" report "$EXEC_FILE" \
        --classfiles "$CLASSES_DIR" --sourcefiles "$UNIT_DIR" \
        --xml "$OUT_DIR/jacoco.xml" > "$OUT_DIR/jacoco-report.log" 2>&1 \
        || REASONS+=("jacococli report failed: see jacoco-report.log")
else
    REASONS+=("jacoco report not generated: agent, cli or exec data missing")
    : > "$OUT_DIR/jacoco.xml"
fi

write_status true "$JAVA_VER_OUT"
exit 0
