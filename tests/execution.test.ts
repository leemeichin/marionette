/**
 * Phase 2 ingestion & execution: external refs, delivery config, the brief
 * (work packet), and state migration (rebind).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { buildBrief, renderBrief } from '../src/brief.js';
import { resolveDelivery } from '../src/refs.js';
import { WalkError, initState, rebindState, takeChoice } from '../src/state.js';

const AT = '2026-01-01T00:00:00.000Z';

const PLAN = `
# project: refs-demo
# github:repo: acme/platform
# jira:site: https://acme.atlassian.net/
# linear:workspace: acme
# ref: https://wiki.acme.dev/brief
# delivery: single-pr
# report: at-checkpoints
VAR n = 0

=== a ===
First phase.
# github:issue: 12, 14
# github:pr: other/repo#9
# jira: proj-7
# linear: ENG-42
# delivery: pr-per-phase
# delivery:branch: work/{phase}
~ n += 1
+ {n < 2} [Again] ~loop~ -> a
* {n >= 2} [Done] -> b

=== b ===
Second phase.
* [Ship] @human -> END
`;

test('refs: well-known namespaces normalise with plan-level context', async () => {
  const { trajectory, diagnostics } = await compile(PLAN);
  assert.ok(trajectory);
  assert.equal(diagnostics.length, 0, diagnostics.map((d) => d.message).join('; '));

  assert.deepEqual(trajectory!.refs, [
    { provider: 'github', kind: 'repo', id: 'acme/platform', url: 'https://github.com/acme/platform' },
    { provider: 'url', kind: 'link', id: 'https://wiki.acme.dev/brief', url: 'https://wiki.acme.dev/brief' },
  ]);

  const a = trajectory!.nodes.find((x) => x.id === 'a')!;
  assert.deepEqual(a.refs, [
    { provider: 'github', kind: 'issue', id: 'acme/platform#12', url: 'https://github.com/acme/platform/issues/12' },
    { provider: 'github', kind: 'issue', id: 'acme/platform#14', url: 'https://github.com/acme/platform/issues/14' },
    { provider: 'github', kind: 'pr', id: 'other/repo#9', url: 'https://github.com/other/repo/pull/9' },
    { provider: 'jira', kind: 'issue', id: 'PROJ-7', url: 'https://acme.atlassian.net/browse/PROJ-7' },
    { provider: 'linear', kind: 'issue', id: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42' },
  ]);
});

test('refs: missing context degrades to url:null; malformed values warn MAR018', async () => {
  const { trajectory, diagnostics } = await compile(`
# github:issue: 5
# jira: not a key
=== a ===
Alpha.
-> END
`);
  const a = trajectory!.nodes[0];
  assert.deepEqual(trajectory!.refs, [{ provider: 'github', kind: 'issue', id: '#5', url: null }]);
  assert.equal(a.refs.length, 0);
  const mar018 = diagnostics.filter((d) => d.code === 'MAR018');
  assert.equal(mar018.length, 1);
  assert.match(mar018[0].message, /jira/);
});

test('refs: repeated metadata tags accumulate instead of overwriting', async () => {
  const { trajectory } = await compile(`
=== a ===
Alpha.
# ref: https://one.example
# ref: https://two.example
-> END
`);
  assert.deepEqual(trajectory!.nodes[0].refs.map((r) => r.id),
    ['https://one.example', 'https://two.example']);
});

test('delivery: node tags override plan tags; {phase} expands; unknown values warn MAR019', async () => {
  const { trajectory } = await compile(PLAN);
  const [a, b] = trajectory!.nodes;
  assert.deepEqual(resolveDelivery(trajectory!.meta, a.meta, a.id),
    { mode: 'pr-per-phase', report: 'at-checkpoints', branch: 'work/a' });
  assert.deepEqual(resolveDelivery(trajectory!.meta, b.meta, b.id),
    { mode: 'single-pr', report: 'at-checkpoints', branch: null });

  const { diagnostics } = await compile('# delivery: yolo\n# report: sometimes\n=== a ===\nAlpha.\n-> END\n');
  assert.equal(diagnostics.filter((d) => d.code === 'MAR019').length, 2);
});

test('brief: active packet carries node, refs, delivery, evaluated frontier and protocol', async () => {
  const { trajectory } = await compile(PLAN, { file: 'plan.mar' });
  const state = initState(trajectory!, 'system', AT);
  const brief = buildBrief(trajectory!, state, { file: 'plan.mar' });

  assert.equal(brief.status, 'active');
  assert.equal(brief.node!.id, 'a');
  assert.equal(brief.node!.title, 'First phase.');
  assert.equal(brief.plan.project, 'refs-demo');
  assert.deepEqual(brief.delivery, { mode: 'pr-per-phase', report: 'at-checkpoints', branch: 'work/a' });
  assert.equal(brief.frontier.length, 2);
  assert.equal(brief.frontier[0].available, true);
  assert.equal(brief.frontier[1].available, false);
  assert.equal(brief.frontier[1].blockedCode, 'gate-blocked');
  assert.equal(brief.escalation, null);
  assert.match(brief.protocol.choose, /marionette state choose plan\.mar/);

  const text = renderBrief(brief);
  assert.match(text, /=== a ===/);
  assert.match(text, /pr-per-phase/);
  assert.match(text, /unavailable/);
});

test('brief: awaiting-human when every available choice is @human, with escalation', async () => {
  const { trajectory } = await compile(PLAN, { file: 'plan.mar' });
  const state = initState(trajectory!, 'system', AT);
  takeChoice(trajectory!, state, 'Again', { actor: 'agent', rationale: 'iterate', at: AT });
  takeChoice(trajectory!, state, 'Done', { actor: 'agent', rationale: 'n reached 2', at: AT });
  const brief = buildBrief(trajectory!, state, { file: 'plan.mar' });

  assert.equal(brief.status, 'awaiting-human');
  assert.ok(brief.escalation);
  assert.deepEqual(brief.escalation!.choices, ['b#0']);
  assert.match(brief.escalation!.how, /--actor <name>/);
  assert.match(renderBrief(brief), /escalation required/);
});

test('brief: stranded when nothing is available and there is no divert', async () => {
  const { trajectory } = await compile(`
VAR go = false
=== a ===
Alpha.
~ go = false
* {go} [Proceed] -> END
`);
  const state = initState(trajectory!, 'system', AT);
  const brief = buildBrief(trajectory!, state);
  assert.equal(brief.status, 'stranded');
  assert.match(renderBrief(brief), /stuck/);
});

test('brief: completed packet has null node and empty frontier', async () => {
  const { trajectory } = await compile('=== a ===\nAlpha.\n* [Ship] -> END\n');
  const state = initState(trajectory!, 'system', AT);
  takeChoice(trajectory!, state, '0', { actor: 'agent', rationale: 'shipped', at: AT });
  const brief = buildBrief(trajectory!, state);
  assert.equal(brief.status, 'completed');
  assert.equal(brief.node, null);
  assert.equal(brief.frontier.length, 0);
  assert.match(renderBrief(brief), /reached END/);
});

test('rebind: migrates state across a plan edit, keeping the log', async () => {
  const v1 = (await compile('VAR n = 0\n=== a ===\nAlpha.\n~ n += 1\n* [Go] -> b\n=== b ===\nBeta.\n* [Ship] -> END\n')).trajectory!;
  const state = initState(v1, 'system', AT);
  takeChoice(v1, state, '0', { actor: 'agent', rationale: 'go', at: AT });

  const v2 = (await compile(
    'VAR added = true\n=== a ===\nAlpha.\n-> b\n=== b ===\nBeta, reworded.\n* [Ship] -> END\n* [Hold] @human -> END\n',
  )).trajectory!;
  assert.notEqual(v1.hash, v2.hash);

  const report = rebindState(v2, state);
  assert.equal(state.hash, v2.hash);
  assert.deepEqual(report.droppedTaken, ['a#0']);
  assert.deepEqual(Object.keys(report.droppedVariables), ['n']);
  assert.deepEqual(report.addedVariables, { added: true });
  assert.equal(state.log.length, 2, 'decision log survives migration');
  assert.equal(state.current, 'b');
});

test('rebind: refuses when the current phase no longer exists', async () => {
  const v1 = (await compile('=== a ===\nAlpha.\n* [Go] -> b\n=== b ===\nBeta.\n* [Ship] -> END\n')).trajectory!;
  const state = initState(v1, 'system', AT);
  takeChoice(v1, state, '0', { actor: 'agent', rationale: 'go', at: AT });

  const v2 = (await compile('=== a ===\nAlpha.\n* [Ship] -> END\n')).trajectory!;
  assert.throws(
    () => rebindState(v2, state),
    (e: unknown) => e instanceof WalkError && e.code === 'migration-blocked',
  );
});
