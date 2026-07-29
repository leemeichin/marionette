import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/compile.ts';
import { emitFacts } from '../src/facts.ts';
import { oracleQuery } from '../src/oracle.ts';
import { buildBrief, renderBrief } from '../src/brief.ts';
import { renderMermaid } from '../src/render.ts';
import {
  answer, ask, frontier, initState, parseState, serializeState, takeChoice, WalkError,
} from '../src/state.ts';
import {
  buildRuntimeProjection, createRuntimeSnapshot, executeRuntimeRequest,
} from '../src/runtime.ts';
import {
  commitRuntimeStore, initializeRuntimeStore, loadRuntimeStore,
} from '../src/runtime-store.ts';
import {
  parseRuntimeRequest, ProtocolError, RUNTIME_PROTOCOL_VERSION,
  type RuntimePrincipal,
} from '../src/runtime-protocol.ts';

const SOURCE = `
=== decide ===
Choose from the available evidence.
* [The next step is clear] -> done
* [I'm not sure] @ask -> reconsider

=== reconsider ===
Re-evaluate the route with the human's answer in the elicitation audit.
-> END

=== done ===
-> END
`;

async function trajectory() {
  const result = await compile(SOURCE, { file: 'ask.mar' });
  assert.ok(result.ok, result.diagnostics.map((item) => item.message).join('; '));
  return result.trajectory!;
}

test('@ask compiles as an elicitation edge and renders as an interrobang', async () => {
  const compiled = await trajectory();
  const choice = compiled.nodes[0].choices[1];
  assert.equal(choice.ask, true);
  assert.equal(choice.human, false);
  assert.match(await renderMermaid(compiled), /‽ I'm not sure/);

  const invalid = await compile(`
=== a ===
* [Confused authority] @human @ask -> END
`);
  assert.equal(invalid.ok, false);
  assert.match(invalid.diagnostics[0].message, /cannot be both @human and @ask/);
});

test('@ask remains a graph edge but is not unattended agent reachability', async () => {
  const compiled = (await compile(`
=== ambiguous ===
* [I'm not sure] @ask -> END
`)).trajectory!;
  const facts = emitFacts(compiled);
  assert.equal((await oracleQuery(facts, 'elicitation_gate(C, N, Label)')).length, 1);
  assert.deepEqual(await oracleQuery(facts, 'unattended_completion'), []);
});

test('@ask parks traversal until a human answer advances the fixed edge', async () => {
  const compiled = await trajectory();
  let state = await initState(compiled, 'system', '2026-07-29T20:00:00.000Z');

  await assert.rejects(
    takeChoice(compiled, state, 'decide#1', {
      actor: 'agent',
      rationale: 'missing a deployment constraint',
    }),
    (error: unknown) => error instanceof WalkError && error.code === 'elicitation-required',
  );

  state = await ask(compiled, state, 'decide#1', {
    actor: 'agent',
    question: 'Must this work without network access after installation?',
    rationale: 'the packaging route depends on this constraint',
    at: '2026-07-29T20:01:00.000Z',
  });
  assert.equal(state.current, 'decide');
  assert.equal(state.pendingElicitation?.choice, 'decide#1');
  assert.equal((await frontier(compiled, state))[0].blockedCode, 'elicitation-pending');

  const brief = await buildBrief(compiled, state, { file: 'ask.mar' });
  assert.equal(brief.status, 'awaiting-elicitation');
  assert.equal(brief.elicitation?.question,
    'Must this work without network access after installation?');
  assert.match(renderBrief(brief), /clarification required ‽/);

  await assert.rejects(
    answer(compiled, state, { actor: 'agent', answer: 'yes' }),
    (error: unknown) => error instanceof WalkError && error.code === 'human-checkpoint',
  );
  state = await answer(compiled, state, {
    actor: 'lee',
    answer: 'Yes; unpacking is allowed, but no runtime download.',
    at: '2026-07-29T20:02:00.000Z',
  });
  assert.equal(state.current, 'reconsider');
  assert.equal(state.pendingElicitation, null);
  assert.equal(state.elicitations[0].answeredBy, 'lee');
  assert.match(state.log.at(-1)?.rationale ?? '', /clarified by lee/);
  assert.equal((await buildBrief(compiled, state)).clarification?.answer,
    'Yes; unpacking is allowed, but no runtime download.');
  assert.deepEqual(parseState(serializeState(state)), state);
});

test('runtime separates agent ask from human answer and preserves the elicitation id', async () => {
  const compiled = await trajectory();
  const agent: RuntimePrincipal = { id: 'agent-1', role: 'agent' };
  const human: RuntimePrincipal = { id: 'lee', role: 'human' };
  const initial = await createRuntimeSnapshot(compiled, {
    runId: 'ask-run',
    at: '2026-07-29T20:00:00.000Z',
  });

  await assert.rejects(
    executeRuntimeRequest(compiled, initial, agent, {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 'wrong-op',
      op: 'choose',
      choiceId: 'decide#1',
      rationale: 'uncertain',
      expectedRevision: 0,
    }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === 'elicitation-required',
  );

  const opened = await executeRuntimeRequest(compiled, initial, agent, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 'ask',
    op: 'ask',
    choiceId: 'decide#1',
    question: 'Which platforms are required for the first release?',
    rationale: 'the artifact matrix is underspecified',
    expectedRevision: 0,
    idempotencyKey: 'ask-1',
  }, { at: '2026-07-29T20:01:00.000Z' });
  assert.deepEqual(opened.events.map((item) => item.kind), ['elicitation.required']);
  const waiting = opened.result.projection as Awaited<ReturnType<typeof buildRuntimeProjection>>;
  assert.equal(waiting.status, 'awaiting-elicitation');
  assert.match(waiting.elicitation?.id ?? '', /\/elicitation\/\d+$/);
  assert.equal(waiting.elicitation?.id, opened.events[0].data['id']);

  await assert.rejects(
    executeRuntimeRequest(compiled, opened.snapshot, agent, {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 'fake-answer',
      op: 'answer',
      answer: 'macOS only',
      expectedRevision: 1,
    }),
    (error: unknown) => error instanceof ProtocolError && error.code === 'forbidden',
  );

  const resolved = await executeRuntimeRequest(compiled, opened.snapshot, human, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 'answer',
    op: 'answer',
    answer: 'macOS arm64 and x86_64 Linux',
    expectedRevision: 1,
    idempotencyKey: 'answer-1',
  }, { at: '2026-07-29T20:02:00.000Z' });
  assert.deepEqual(resolved.events.map((item) => item.kind),
    ['elicitation.answered', 'node.entered']);
  assert.equal(resolved.snapshot.state.current, 'reconsider');
  const projection = resolved.result.projection as Awaited<ReturnType<typeof buildRuntimeProjection>>;
  assert.equal(projection.status, 'active');
  assert.equal(projection.clarification?.answer, 'macOS arm64 and x86_64 Linux');
});

test('runtime protocol parses ask and answer as distinct writes', () => {
  assert.equal(parseRuntimeRequest({
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 1,
    op: 'ask',
    choiceId: 'decide#1',
    question: 'What is missing?',
    rationale: 'the route is ambiguous',
    expectedRevision: 0,
  }).op, 'ask');
  assert.equal(parseRuntimeRequest({
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 2,
    op: 'answer',
    answer: 'The missing constraint',
    expectedRevision: 1,
  }).op, 'answer');
});

test('runtime journal replays an @ask exchange as one request and one answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-ask-'));
  try {
    const compiled = await trajectory();
    const agent: RuntimePrincipal = { id: 'agent-1', role: 'agent' };
    const human: RuntimePrincipal = { id: 'lee', role: 'human' };
    const initial = await initializeRuntimeStore(root, compiled, {
      runId: 'durable-ask',
      principal: agent,
      at: '2026-07-29T20:00:00.000Z',
    });
    const opened = await executeRuntimeRequest(compiled, initial, agent, {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 'ask',
      op: 'ask',
      choiceId: 'decide#1',
      question: 'Which release targets are required?',
      rationale: 'the matrix is ambiguous',
      expectedRevision: 0,
      idempotencyKey: 'ask-durable',
    }, { at: '2026-07-29T20:01:00.000Z' });
    commitRuntimeStore(root, compiled, initial, opened.snapshot, opened.events);

    const resolved = await executeRuntimeRequest(compiled, opened.snapshot, human, {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 'answer',
      op: 'answer',
      answer: 'macOS arm64 and x86_64 Linux',
      expectedRevision: 1,
      idempotencyKey: 'answer-durable',
    }, { at: '2026-07-29T20:02:00.000Z' });
    commitRuntimeStore(root, compiled, opened.snapshot, resolved.snapshot, resolved.events);

    const replayed = await loadRuntimeStore(root, 'durable-ask', compiled);
    assert.equal(replayed.revision, 2);
    assert.equal(replayed.state.current, 'reconsider');
    assert.equal(replayed.state.elicitations[0].answer,
      'macOS arm64 and x86_64 Linux');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
