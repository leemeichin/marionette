import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
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

test('state rebind dry-runs and applies only future changes with JSON reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-amend-cli-'));
  const file = join(dir, 'plan.mar');
  writeFileSync(file, '=== a ===\nAlpha.\n* [Go] -> b\n=== b ===\nBeta.\n-> END\n');
  assert.equal(cli(['state', 'init', 'plan.mar'], dir).code, 0);
  assert.equal(cli(['state', 'choose', 'plan.mar', 'a#0', '--actor', 'agent', '--rationale', 'alpha done'], dir).code, 0);
  const stateFile = join(dir, 'plan.state.json');
  const oldHash = JSON.parse(readFileSync(stateFile, 'utf8')).hash;

  writeFileSync(file, [
    '=== a ===',
    'Alpha.',
    '* [Go] -> b',
    '=== b ===',
    'Beta updated before completion.',
    '-> c',
    '=== c ===',
    'New future phase.',
    '-> END',
    '',
  ].join('\n'));
  const dryRun = cli(['state', 'rebind', 'plan.mar', '--dry-run', '--json'], dir);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const dryReport = JSON.parse(dryRun.stdout);
  assert.equal(dryReport.amendment.allowed, true);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).hash, oldHash, 'dry-run does not persist');

  const applied = cli([
    'state', 'rebind', 'plan.mar', '--json', '--actor', 'lee', '--rationale', 'approved future work',
  ], dir);
  assert.equal(applied.code, 0, applied.stderr);
  const appliedReport = JSON.parse(applied.stdout);
  assert.equal(appliedReport.amendment.allowed, true);
  const appliedState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(appliedState.hash, appliedReport.toHash);
  assert.equal(appliedState.log.at(-1).actor, 'lee');

  const acceptedStateText = readFileSync(stateFile, 'utf8');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Alpha.', 'Alpha rewritten after completion.'));
  const refused = cli(['state', 'rebind', 'plan.mar', '--json'], dir);
  assert.equal(refused.code, 1);
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.allowed, false);
  assert.ok(refusal.violations.some((violation: { code: string }) =>
    violation.code === 'completed-phase-changed'));
  assert.equal(readFileSync(stateFile, 'utf8'), acceptedStateText, 'refusal leaves state untouched');
});

test('state baseline recovers an unchanged legacy state before editing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-baseline-cli-'));
  writeFileSync(join(dir, 'plan.mar'), '=== a ===\nAlpha.\n-> END\n');
  assert.equal(cli(['state', 'init', 'plan.mar'], dir).code, 0);
  rmSync(join(dir, '.marionette'), { recursive: true, force: true });
  assert.equal(existsSync(join(dir, '.marionette')), false);
  const baseline = cli(['state', 'baseline', 'plan.mar', '--json'], dir);
  assert.equal(baseline.code, 0, baseline.stderr);
  assert.equal(JSON.parse(baseline.stdout).hash, JSON.parse(readFileSync(join(dir, 'plan.state.json'), 'utf8')).hash);
  assert.equal(existsSync(join(dir, '.marionette', 'graphs')), true);
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
      protocol: '0.4.0',
      id: 1,
      op: 'initialize',
      client: { name: 'cli-test', version: '1' },
    }),
    JSON.stringify({ protocol: '0.4.0', id: 2, op: 'next', profile: 'signal' }),
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

test('state ask and answer keep clarification distinct from choosing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marionette-ask-cli-'));
  writeFileSync(join(dir, 'ask.mar'), [
    '=== decide ===',
    '* [I am not sure] @ask -> reconsider',
    '=== reconsider ===',
    'Use the supplied context.',
    '-> END',
    '',
  ].join('\n'));

  assert.equal(cli(['state', 'init', 'ask.mar'], dir).code, 0);
  const chose = cli([
    'state', 'choose', 'ask.mar', '0',
    '--actor', 'agent', '--rationale', 'uncertain',
  ], dir);
  assert.equal(chose.code, 1);
  assert.match(chose.stderr, /@ask/);

  const opened = cli([
    'state', 'ask', 'ask.mar', '0',
    '--question', 'Which release targets are required?',
    '--actor', 'agent',
    '--rationale', 'the matrix is ambiguous',
  ], dir);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /clarification required ‽/);

  const resolved = cli([
    'state', 'answer', 'ask.mar', 'macOS arm64 and x86_64 Linux',
    '--actor', 'lee',
  ], dir);
  assert.equal(resolved.code, 0, resolved.stderr);
  const state = JSON.parse(readFileSync(join(dir, 'ask.state.json'), 'utf8'));
  assert.equal(state.current, 'reconsider');
  assert.equal(state.elicitations[0].answeredBy, 'lee');
});
