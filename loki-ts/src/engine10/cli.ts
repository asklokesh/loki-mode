// Loki 10 engine subcommand router (ENGINE.md section 11, slice E-12).
// Reached only through `loki-ts/src/cli.ts` case "engine10", which bin/loki
// selects when LOKI_ENGINE=v10. Every target module is loaded lazily, and no
// sibling module (types.ts included) is imported statically, so this file
// works before its siblings exist: a missing module prints
// "engine10: <module> not built yet" and exits 2.
//
// Module contract: each target exports `main(args: string[])` returning an
// exit code (or void for 0); stages/deep.ts exports `deepSupervise` and
// `deepWorker` instead.

export interface Route {
  module: string; // path relative to this directory
  fn: string; // exported function name
  args: string[];
}

const TABLE: Record<string, { module: string; fn: string }> = {
  status: { module: "status.ts", fn: "main" },
  verify: { module: "verify_cmd.ts", fn: "main" },
  dashboard: { module: "dashboard/server.ts", fn: "main" },
  // Hidden subcommands spawned by the supervisor.
  worker: { module: "worker.ts", fn: "main" },
  session: { module: "session.ts", fn: "main" },
  "deep-supervise": { module: "stages/deep.ts", fn: "deepSupervise" },
  "deep-worker": { module: "stages/deep.ts", fn: "deepWorker" },
};

const USAGE = `Usage (LOKI_ENGINE=v10):
  loki "<task>"                   run the engine on a free-text task
  loki <issue-url|owner/repo#N>   run on an issue
  loki status [run-id]            latest run by default
  loki verify [run-id]            check receipt hashes and signature
  loki dashboard                  serve the local dashboard
Flags: --deep, --provider <name>, --resume <run-id>, --no-pr
`;

// Returns null for an empty or help invocation.
export function route(args: string[]): Route | null {
  const [first, ...rest] = args;
  if (first === undefined || first === "" || first === "--help" || first === "-h") return null;
  const hit = TABLE[first];
  if (hit) return { ...hit, args: rest };
  // Anything else is a run: a task, an issue ref, or flags plus either.
  return { module: "supervisor.ts", fn: "main", args };
}

export type Loader = (specifier: string) => Promise<Record<string, unknown>>;

// A non-literal specifier keeps `bun build` from trying to bundle modules
// that do not exist yet.
// ponytail: dist only reaches these once they are bundled; switch to literal
// imports when every target module has landed.
const defaultLoader: Loader = (spec) => import(spec);

function isMissing(err: unknown, module: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  const msg = String(e?.message ?? "");
  const notFound =
    e?.code === "ERR_MODULE_NOT_FOUND" ||
    e?.code === "MODULE_NOT_FOUND" ||
    /Cannot find module|Module not found/i.test(msg);
  // Only the target itself counts; a missing import inside it is a real error.
  const base = module.split("/").pop() as string;
  return notFound && msg.includes(base);
}

export async function runEngine10(args: string[], load: Loader = defaultLoader): Promise<number> {
  const r = route(args);
  if (!r) {
    const help = args[0] === "--help" || args[0] === "-h";
    (help ? process.stdout : process.stderr).write(USAGE);
    return help ? 0 : 2;
  }
  let mod: Record<string, unknown>;
  try {
    mod = await load(`./${r.module}`);
  } catch (err) {
    if (!isMissing(err, r.module)) throw err;
    process.stderr.write(`engine10: ${r.module} not built yet\n`);
    return 2;
  }
  const fn = mod[r.fn];
  if (typeof fn !== "function") {
    process.stderr.write(`engine10: ${r.module} does not export ${r.fn}\n`);
    return 2;
  }
  const code = await (fn as (a: string[]) => unknown)(r.args);
  return typeof code === "number" ? code : 0;
}
