import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { CODES } from '../src/types.js';

async function mustCompile(source: string) {
  const result = await compile(source);
  assert.equal(
    result.diagnostics.filter((d) => d.severity === 'error').length, 0,
    'expected no errors, got:\n' + result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'),
  );
  assert.ok(result.trajectory);
  return result.trajectory!;
}

test('P0.2 construct: phases, prose bodies, start divert', async () => {
  const t = await mustCompile(`
-> b
=== a ===
Unused but reachable via b.
-> END
=== b ===
First line.
Second line.
-> a
`);
  assert.equal(t.start, 'b');
  assert.equal(t.nodes.length, 2);
  assert.equal(t.nodes[1].body, 'First line.\nSecond line.');
});

test('P0.2 construct: typed VARs (number, boolean, string)', async () => {
  const t = await mustCompile(`
VAR n = 3
VAR flag = true
VAR name = "mvp"
=== a ===
* {n > 0 && flag && name == "mvp"} [Go] -> END
* [Stop] -> END
`);
  assert.deepEqual(t.variables['n'], { type: 'number', initial: 3, line: 2 });
  assert.deepEqual(t.variables['flag'], { type: 'boolean', initial: true, line: 3 });
  assert.deepEqual(t.variables['name'], { type: 'string', initial: 'mvp', line: 4 });
});

test('P0.2 construct: once-only (*) vs sticky (+) choices', async () => {
  const t = await mustCompile(`
=== a ===
* [Once] -> END
+ [Repeat] -> END
`);
  assert.equal(t.nodes[0].choices[0].sticky, false);
  assert.equal(t.nodes[0].choices[1].sticky, true);
});

test('P0.2 construct: gates, @human, ~loop~, diverts, END', async () => {
  const t = await mustCompile(`
VAR i = 0
=== a ===
~ i += 1
+ {i < 5} [Again] ~loop~ -> a
* {i >= 5} [Enough] @human -> b
=== b ===
-> END
`);
  const [loop, human] = t.nodes[0].choices;
  assert.equal(loop.loop, true);
  assert.equal(loop.human, false);
  assert.equal(loop.gate?.source, 'i < 5');
  assert.equal(human.human, true);
  assert.equal(human.target, 'b');
  assert.deepEqual(t.nodes[1].divert, { target: 'END', line: 8 });
});

test('P0.2 construct: mutations =, +=, -=', async () => {
  const t = await mustCompile(`
VAR i = 10
VAR s = "x"
=== a ===
~ i -= 2
~ i = i * 2
~ s = "y"
-> END
`);
  assert.deepEqual(t.nodes[0].actions.map((a) => a.op), ['-=', '=', '=']);
});

test('P0.2 construct: comments stripped, including after content', async () => {
  const t = await mustCompile(`
// full-line comment
=== a === // trailing comment
Body text. // this comment goes; URLs like https://x are prose, not comments
-> END
`);
  assert.equal(t.nodes[0].body, 'Body text.');
});

test('P0.2 construct: metadata tags (plan-level and node-level)', async () => {
  const t = await mustCompile(`
# project: demo
# draft
=== a ===
# github:issue: 42
# critical
-> END
`);
  assert.equal(t.meta['project'], 'demo');
  assert.deepEqual(t.meta['tags'], ['draft']);
  assert.equal(t.nodes[0].meta['github:issue'], '42');
  assert.deepEqual(t.nodes[0].meta['tags'], ['critical']);
});

test('flexible choice part order: gate after label', async () => {
  const t = await mustCompile(`
VAR ok = true
=== a ===
* [Go] {ok} -> END
+ [Halt] -> END
`);
  assert.equal(t.nodes[0].choices[0].gate?.source, 'ok');
});

test('parse errors carry line numbers and suggestions', async () => {
  const result = await compile(`
=== a ===
* [No divert here]
`);
  const err = result.diagnostics.find((d) => d.code === CODES.PARSE);
  assert.ok(err);
  assert.equal(err!.line, 3);
  assert.ok(err!.suggestion);
});

test('choice without label is rejected', async () => {
  const result = await compile(`
=== a ===
* -> END
`);
  assert.ok(result.diagnostics.some((d) => d.code === CODES.PARSE && /label/.test(d.message)));
});

test('metadata: # key: """ fences a verbatim markdown value', async () => {
  const result = await compile(`# summary: Ship the importer.
# prompt: """
Build the importer against the vendor API.

- retry twice, then fall back to CSV
- ## headings and # tags in here are text, not metadata
"""
=== a ===
Alpha.
* [Ship] -> END
`);
  assert.equal(result.diagnostics.length, 0);
  const meta = result.trajectory!.meta;
  assert.equal(meta['prompt'],
    'Build the importer against the vendor API.\n\n- retry twice, then fall back to CSV\n- ## headings and # tags in here are text, not metadata');
  assert.equal(meta['summary'], 'Ship the importer.');
});

test('metadata: unterminated """ fence is a parse error', async () => {
  const result = await compile('# prompt: """\nnever closed\n=== a ===\nAlpha.\n* [Ship] -> END\n');
  const hit = result.diagnostics.find((d) => d.code === 'MAR001');
  assert.ok(hit && /unterminated/.test(hit.message));
});
