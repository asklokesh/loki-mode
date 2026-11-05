export class ExitError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export class MultiError extends Error {
  constructor(errors) { super(errors.map((e) => e.message).join("\n")); this.errors = errors; }
}

// Returns the process exit code an error maps to (0 when err is null).
export function exitCodeFor(err) {
  if (!err) return 0;
  if (err instanceof ExitError) return err.code;
  if (err instanceof MultiError) return multiCode(err);
  return 1;
}

function multiCode(merr) {
  let code = 1;
  for (const e of merr.errors) {
    if (e instanceof ExitError) code = e.code;
  }
  return code;
}
