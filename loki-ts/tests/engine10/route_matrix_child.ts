// Child-process entry for the route matrix. Evaluates matrixViolations(root) in its own bun process so the parent
// test process (which may run with --coverage) never loads a mutated temp copy of src/ (FC-34).
// Usage: bun route_matrix_child.ts <src root>. Prints one JSON array of violation strings on stdout.
import { matrixViolations } from "./route_matrix_lib.ts";

const root = process.argv[2];
if (!root) { console.error("usage: route_matrix_child.ts <src root>"); process.exit(2); }
const violations = await matrixViolations(root);
process.stdout.write(JSON.stringify(violations) + "\n");
process.exit(0);
