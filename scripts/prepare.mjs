import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

if (!existsSync(join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'))) {
  console.log('Skipping library build: production-only Pi install loads src/pi-extension.ts directly.');
  process.exit(0);
}

const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
