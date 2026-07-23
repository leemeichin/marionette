import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Run from the repo root (so "--import tsx" resolves); plan paths are absolute.
function cli(args: string[], dir: string): { code: number; stdout: string; stderr: string } {
  const absolute = args.map((a) => a.endsWith('.mar') || a.endsWith('.json') ? join(dir, a) : a);
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'src/cli.ts'), ...absolute],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('P0.8 CLI exit codes are CI-suitable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-'));
  cpSync(join(here, 'fixtures/kitchen_sink.mar'), join(dir, 'plan.mar'));

  // validate: clean plan → 0
  assert.equal(cli(['validate', 'plan.mar'], dir).code, 0);

  // compile writes the trajectory next to the plan
  assert.equal(cli(['compile', 'plan.mar'], dir).code, 0);
  const trajectory = JSON.parse(readFileSync(join(dir, 'plan.trajectory.json'), 'utf8'));
  assert.match(trajectory.hash, /^sha256:[0-9a-f]{64}$/);

  // invalid plan → 1, diagnostics on stderr
  writeFileSync(join(dir, 'bad.mar'), '=== a ===\n* [Go] -> nowhere\n');
  const bad = cli(['validate', 'bad.mar'], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /MAR003/);

  // usage error → 2
  assert.equal(cli(['validate'], dir).code, 2);
  assert.equal(cli(['frobnicate'], dir).code, 2);

  // render and summarize work from both .mar and compiled .json
  assert.match(cli(['render', 'plan.mar'], dir).stdout, /flowchart/);
  assert.match(cli(['render', 'plan.trajectory.json'], dir).stdout, /flowchart/);
  assert.match(cli(['summarize', 'plan.mar'], dir).stdout, /Plan summary/);

  // state lifecycle: init → choose → drift → 3
  assert.equal(cli(['state', 'init', 'plan.mar'], dir).code, 0);
  const choose = cli(['state', 'choose', 'plan.mar', 'Learnings', '--actor', 'agent', '--rationale', 'iterate'], dir);
  assert.equal(choose.code, 0, choose.stderr);
  // @human refusal for agents → 1
  const humanRefusal = cli(['state', 'choose', 'plan.mar', 'Metrics', '--actor', 'agent', '--rationale', 'x'], dir);
  assert.equal(humanRefusal.code, 1);
  assert.match(humanRefusal.stderr, /@human/);
  // mutate the plan → drift → 3
  const source = readFileSync(join(dir, 'plan.mar'), 'utf8');
  writeFileSync(join(dir, 'plan.mar'), source.replace('iteration < 3', 'iteration < 4'));
  const drifted = cli(['state', 'show', 'plan.mar'], dir);
  assert.equal(drifted.code, 3);
  assert.match(drifted.stderr, /drift/);
});
