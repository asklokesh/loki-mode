#!/usr/bin/env bash
# Builds the check-0B pnpm workspace fixture (zod- and tq-shaped, new domain) at $1 and prints the base sha.
# Legs are branches: h1-tq (unrelated edit; pre-existing red test, unused locals, TS2305), h2-break-core (a workspace package edit breaks
# two untouched tests), h3-drop-export (a workspace package drops an export: introduced TS2305 in untouched files). Needs pnpm and network.
set -euo pipefail
F="$1"; mkdir -p "$F/packages/core/src" "$F/packages/shape/src/tests"; cd "$F"
g() { git -c user.name=f -c user.email=f@example.invalid "$@"; }
printf '{ "name": "ws-root", "private": true, "scripts": { "test": "vitest run" }, "devDependencies": { "typescript": "5.6.3", "vitest": "2.1.9" } }\n' > package.json
printf 'packages:\n  - "packages/*"\n' > pnpm-workspace.yaml; printf 'node_modules\n' > .gitignore
printf '{ "name": "@ws/core", "version": "1.0.0", "main": "src/index.ts", "types": "src/index.ts" }\n' > packages/core/package.json
echo 'export const unit = (n: number): string => `${n}u`;' > packages/core/src/index.ts
printf '{ "name": "@ws/shape", "version": "1.0.0", "scripts": { "test": "vitest run" }, "dependencies": { "@ws/core": "workspace:*" }, "devDependencies": { "typescript": "5.6.3", "vitest": "2.1.9" } }\n' > packages/shape/package.json
printf '{ "compilerOptions": { "strict": true, "noEmit": true, "noUnusedLocals": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022", "types": [], "skipLibCheck": true }, "include": ["src"] }\n' > packages/shape/tsconfig.json
printf 'import { unit } from "@ws/core";\nexport function area(w: number, h: number): string { return unit(w * h); }\n' > packages/shape/src/area.ts
printf 'import { test, expect } from "vitest";\ntype _Cat = { a: string };\ntest("legacy", () => { const _Outer = 1; expect(1).toBe(1); });\n' > packages/shape/src/tests/legacy.test.ts
printf 'import { test, expect } from "vitest";\ntest("needs window", () => { expect(typeof (globalThis as any).window).toBe("object"); });\n' > packages/shape/src/tests/flaky_env.test.ts
printf 'import { test, expect } from "vitest";\nimport { area } from "../area";\ntest("area", () => { expect(area(2, 3)).toBe("6u"); });\n' > packages/shape/src/tests/area.test.ts
printf 'import { test, expect } from "vitest";\nimport { unit } from "@ws/core";\ntest("unit suffix", () => { expect(unit(2)).toBe("2u"); });\n' > packages/shape/src/tests/uses_core.test.ts
printf 'import { parseValid } from "@ws/core";\nexport const bench = parseValid;\n' > packages/shape/src/bench.ts
git init -q -b main; timeout 300 pnpm install --silent >/dev/null 2>&1 || true; g add -A; g commit -qm base; B="$(git rev-parse HEAD)"
git checkout -q -b h1-tq; sed -i.bak 's/unit(w \* h)/unit(Math.abs(w * h))/' packages/shape/src/area.ts; rm -f packages/shape/src/area.ts.bak; g commit -qam h1
git checkout -q -b h2-break-core "$B"; sed -i.bak 's/`${n}u`/`${n} u`/' packages/core/src/index.ts; rm -f packages/core/src/index.ts.bak; g commit -qam h2
git checkout -q -b h3-drop-export "$B"; echo 'export const unitOf = (n: number): string => `${n}u`;' > packages/core/src/index.ts; g commit -qam h3
echo "$B"
