import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

run(['server.js', 'selftest']);

const testDir = join('web', 'src', 'lib');
const tests = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const test of tests) run([join(testDir, test)]);
