import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

test('P0.8 CLI exit codes are CI-suitable', async () => {
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

  // missing file → friendly usage error, not a stack trace
  const missing = cli(['validate', 'no-such.mar'], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read plan .*no-such\.mar: no such file/);
  assert.doesNotMatch(missing.stderr, /at readFileSync/);

  // command typos get a suggestion
  assert.match(cli(['validat', 'plan.mar'], dir).stderr, /did you mean "validate"\?/);

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

test('runtime CLI exposes a clean NDJSON process surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-runtime-cli-'));
  writeFileSync(join(dir, 'plan.mar'), [
    '=== a ===',
    'Alpha.',
    '* [Go] -> END',
    '',
  ].join('\n'));
  const input = [
    JSON.stringify({
      protocol: '0.3.0',
      id: 1,
      op: 'initialize',
      client: { name: 'cli-test', version: '1' },
    }),
    JSON.stringify({ protocol: '0.3.0', id: 2, op: 'next', profile: 'signal' }),
    '',
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', join(root, 'src/cli.ts'),
      'start', join(dir, 'plan.mar'),
      '--run', 'cli-run',
      '--store', join(dir, 'store'),
      '--principal', 'test-agent',
      '--role', 'agent',
    ],
    { cwd: root, input, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[1].result.projection.node.id, 'a');
  assert.doesNotMatch(result.stdout, /runtime created/);
  assert.match(result.stderr, /Marionette started · cli-run/);
  const help = cli(['help'], dir);
  assert.match(help.stdout, /marionette start/);
  assert.match(help.stdout, /marionette stop/);
  const stopped = cli(['stop', 'plan.mar', '--run', 'cli-run', '--store', join(dir, 'store')], dir);
  assert.equal(stopped.code, 0);
});

test('state observe records a late-bound scalar through the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-observe-cli-'));
  writeFileSync(join(dir, 'dynamic.mar'), [
    'VAR remaining: number = ?',
    '=== work ===',
    '~ remaining -= 1',
    'while {remaining > 0} -> work',
    'else -> END',
    '',
  ].join('\n'));

  const initialized = cli(['state', 'init', 'dynamic.mar'], dir);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.match(initialized.stdout, /observations required: remaining:number/);

  const observed = cli([
    'state', 'observe', 'dynamic.mar', 'remaining', '2',
    '--actor', 'agent', '--rationale', 'queue query returned two items',
  ], dir);
  assert.equal(observed.code, 0, observed.stderr);
  const state = JSON.parse(readFileSync(join(dir, 'dynamic.state.json'), 'utf8'));
  assert.equal(state.variables.remaining, 1);
  assert.equal(state.observations[0].rationale, 'queue query returned two items');

  const nonFinite = cli([
    'state', 'observe', 'dynamic.mar', 'remaining', '1e400',
    '--actor', 'agent', '--rationale', 'invalid result',
  ], dir);
  assert.equal(nonFinite.code, 2);
  assert.match(nonFinite.stderr, /finite number/);
});
