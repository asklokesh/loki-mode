import { execFileSync } from 'node:child_process';
import { chmod, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(process.argv[2] ?? '.');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packResult = JSON.parse(execFileSync(npmCommand, [
  'pack', '--dry-run', '--json', '--ignore-scripts',
], {
  cwd: packageRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}));
const packageFiles = packResult[0]?.files?.map(({ path }) => resolve(packageRoot, path)) ?? [];

if (packageFiles.length === 0) {
  throw new Error('npm pack dry-run returned an empty package inventory');
}

await chmod(packageRoot, 0o755);
for (const filePath of packageFiles) {
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink()) continue;
  if (entry.isDirectory()) {
    await chmod(filePath, 0o755);
    continue;
  }
  const { mode } = entry;
  await chmod(filePath, mode & 0o111 ? 0o755 : 0o644);

  for (let directory = dirname(filePath); directory !== packageRoot; directory = dirname(directory)) {
    await chmod(directory, 0o755);
  }
}
