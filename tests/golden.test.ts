import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compile.js';
import { renderMermaid } from '../src/render.js';
import { summarize } from '../src/summarize.js';
import { initState, takeChoice } from '../src/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('golden: kitchen-sink plan compiles to the committed trajectory JSON', () => {
  const result = compile(fixture('kitchen_sink.mar'), { file: 'kitchen_sink.mar' });
  assert.ok(result.ok, result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
  const expected = JSON.parse(fixture('kitchen_sink.trajectory.json'));
  const actual = JSON.parse(JSON.stringify(result.trajectory));
  // source.file is environment-specific and excluded from the hash; ignore it.
  delete actual.source;
  delete expected.source;
  assert.deepEqual(actual, expected);
});

test('golden round-trip: compiled JSON is lossless for graph semantics (P0.1)', () => {
  const source = fixture('kitchen_sink.mar');
  const first = compile(source, { file: 'kitchen_sink.mar' }).trajectory!;
  // Re-compiling the same source must reproduce hash and structure bit-for-bit.
  const second = compile(source, { file: 'elsewhere/kitchen_sink.mar' }).trajectory!;
  assert.equal(first.hash, second.hash);
});

test('render: mermaid marks human (✋), loops (↻, dashed), gates and END', () => {
  const t = compile(fixture('kitchen_sink.mar')).trajectory!;
  const mmd = renderMermaid(t);
  assert.match(mmd, /flowchart TD/);
  assert.match(mmd, /✋/);
  assert.match(mmd, /-\. ".*↻.*" \.->/);
  assert.match(mmd, /\{iteration &lt; 3\}/);
  assert.match(mmd, /END\(\(\(END\)\)\)/);
  assert.match(mmd, /linkStyle \d+ stroke:#c62828/);
});

test('render: taken path, current node and frontier are highlighted from state', () => {
  const t = compile(fixture('kitchen_sink.mar')).trajectory!;
  const state = initState(t);
  takeChoice(t, state, 'Learnings', { actor: 'agent', rationale: 'iterate' });
  const mmd = renderMermaid(t, { state });
  assert.match(mmd, /class .*build_mvp.* taken;/);
  assert.match(mmd, /class build_mvp current;/);
});

test('summarize: counts decision points, loops, human gates, unverified gates (P0.6)', () => {
  const { trajectory, diagnostics } = compile(fixture('kitchen_sink.mar'), { file: 'kitchen_sink.mar' });
  const text = summarize(trajectory!, { diagnostics, file: 'kitchen_sink.mar' });
  assert.match(text, /decision point/);
  assert.match(text, /Human checkpoints:/);
  assert.match(text, /Declared loops:/);
  assert.match(text, /unverified/);
  assert.match(text, /## Compiler report/);
  assert.match(text, /## Walkthrough/);
});
