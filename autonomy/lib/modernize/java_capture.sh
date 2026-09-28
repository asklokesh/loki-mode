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
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

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
EXEC_FILE="$OUT_DIR/jacoco.exec"
if [ -n "$JACOCO_AGENT" ] && [ -f "$JACOCO_AGENT" ]; then
    if [ -n "$TEST_CLASSPATH" ]; then
        # shellcheck disable=SC2086 # CLASSES is a comma list turned into separate class-name args on purpose
        java "-javaagent:${JACOCO_AGENT}=destfile=${EXEC_FILE},append=true" \
            -cp "$CLASSES_DIR:$TEST_CLASSPATH" org.junit.runner.JUnitCore \
            ${CLASSES//,/ } > "$OUT_DIR/junit-existing.log" 2>&1 || true
    fi
else
    REASONS+=("jacoco agent not available: coverage not measured")
fi

# --- 4. Randoop regression tests, compiled and run under the same agent -
if [ -n "$RANDOOP_JAR" ] && [ -f "$RANDOOP_JAR" ]; then
    RANDOOP_OUT="$OUT_DIR/randoop-tests"
    mkdir -p "$RANDOOP_OUT"
    (cd "$RANDOOP_OUT" && java -cp "${RANDOOP_JAR}:${CLASSES_DIR}" randoop.main.Main gentests \
        --testclass="${CLASSES//,/ --testclass=}" \
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
            if [ -n "$JACOCO_AGENT" ] && [ -f "$JACOCO_AGENT" ]; then
                # shellcheck disable=SC2086
                java "-javaagent:${JACOCO_AGENT}=destfile=${EXEC_FILE},append=true" \
                    -cp "${CLASSES_DIR}:${RANDOOP_JAR}" org.junit.runner.JUnitCore \
                    $RANDOOP_CLASSES > "$OUT_DIR/junit-randoop.log" 2>&1 || true
            fi
        else
            REASONS+=("randoop-generated tests failed to compile: see randoop-javac.log")
        fi
    else
        REASONS+=("randoop produced no regression tests")
    fi
else
    REASONS+=("randoop jar not available: no generated regression tests")
fi

# --- 5. JaCoCo XML report (raw, untouched -- java.ts parses it) ---------
if [ -n "$JACOCO_CLI" ] && [ -f "$JACOCO_CLI" ] && [ -f "$EXEC_FILE" ]; then
    java -jar "$JACOCO_CLI" report "$EXEC_FILE" \
        --classfiles "$CLASSES_DIR" --sourcefiles "$UNIT_DIR" \
        --xml "$OUT_DIR/jacoco.xml" > "$OUT_DIR/jacoco-report.log" 2>&1 \
        || REASONS+=("jacococli report failed: see jacoco-report.log")
else
    REASONS+=("jacoco report not generated: agent, cli or exec data missing")
    : > "$OUT_DIR/jacoco.xml"
fi

# --- 6. CaptureRunner: reflective double replay --------------------------
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
                String sig = fqcn + "#" + m.getName() + "(" + m.getParameterCount() + ")";
                boolean okParams = true;
                for (Class<?> p : m.getParameterTypes()) if (!capturable(p)) okParams = false;
                boolean okReturn = capturable(m.getReturnType());
                boolean staticOk = Modifier.isStatic(m.getModifiers()) || hasCtor;
                if (!okParams || !okReturn || !staticOk) {
                    String reason = !staticOk ? "no public zero-arg constructor" : "parameter or return type not capturable";
                    out.println("{\"class\":\"" + esc(fqcn) + "\",\"method\":\"" + esc(sig) + "\",\"not_capturable\":[\"boundary:" + esc(reason) + "\"]}");
                    continue;
                }
                Class<?>[] ptypes = m.getParameterTypes();
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
    java -cp "${OUT_DIR}:${CLASSES_DIR}" CaptureRunner "$OUT_DIR/replay1.jsonl" "$CLASSES" \
        > "$OUT_DIR/replay1.log" 2>&1 || REASONS+=("CaptureRunner replay 1 exited non-zero")
    java -cp "${OUT_DIR}:${CLASSES_DIR}" CaptureRunner "$OUT_DIR/replay2.jsonl" "$CLASSES" \
        > "$OUT_DIR/replay2.log" 2>&1 || REASONS+=("CaptureRunner replay 2 exited non-zero")
else
    REASONS+=("CaptureRunner failed to compile: see runner-javac.log")
    : > "$OUT_DIR/replay1.jsonl"
    : > "$OUT_DIR/replay2.jsonl"
fi

write_status true "$JAVA_VER_OUT"
exit 0
