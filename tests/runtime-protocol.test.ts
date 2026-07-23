import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProtocolError, RUNTIME_PROTOCOL_VERSION, graphReference, parseRuntimeRequest,
} from '../src/runtime-protocol.js';

test('runtime protocol parses compact projection requests', async () => {
  assert.deepEqual(parseRuntimeRequest({
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 1,
    op: 'next',
    profile: 'signal',
    budget: { maxItems: 3, maxBodyChars: 0 },
  }), {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 1,
    op: 'next',
    profile: 'signal',
    budget: { maxItems: 3, maxBodyChars: 0 },
  });
});

test('runtime protocol requires exact choice ids and optimistic revisions', async () => {
  const request = parseRuntimeRequest({
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 'decision-1',
    op: 'choose',
    choiceId: 'build#0',
    rationale: 'tests pass',
    expectedRevision: 4,
    idempotencyKey: 'turn-9',
  });
  assert.equal(request.op, 'choose');
  assert.equal(request.choiceId, 'build#0');
  assert.equal(request.expectedRevision, 4);
});

test('runtime protocol does not let request payloads assert actor identity', async () => {
  assert.throws(
    () => parseRuntimeRequest({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 2,
      op: 'choose',
      choiceId: 'gate#0',
      rationale: 'approved',
      expectedRevision: 1,
      actor: 'lee',
    }),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.code === 'invalid-request' &&
      /actor/.test(error.message),
  );
});

test('runtime protocol rejects unsupported versions with a correlated error', async () => {
  assert.throws(
    () => parseRuntimeRequest({ protocol: '9.0.0', id: 'old', op: 'next' }),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.code === 'unsupported-version' &&
      error.requestId === 'old',
  );
});

test('graph references bind node and choice to one immutable trajectory', async () => {
  const ref = graphReference('sha256:abc', 'build', 'build#0');
  assert.deepEqual(ref, {
    trajectoryHash: 'sha256:abc',
    nodeId: 'build',
    choiceId: 'build#0',
    uri: 'marionette://trajectory/sha256%3Aabc/node/build/choice/build%230',
  });
});
