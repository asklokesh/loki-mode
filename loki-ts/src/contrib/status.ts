// loki-ts/src/contrib/status.ts -- E-21 `loki status [run-id]` router entry. The renderer and run-dir helpers live in commands/run_status.ts.
/** Called by cli.ts router (section 11): `loki status [run-id]`. CLI-MODERN-2: one renderer, shared with the default `loki status`. */
export async function main(args: string[]): Promise<number> {
  return (await import("../commands/run_status.ts")).runModernStatus(args);
}
