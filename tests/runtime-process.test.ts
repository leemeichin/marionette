import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { compile } from '../src/compile.ts';
import { RuntimeService, serveRuntimeLines } from '../src/runtime-process.ts';
import { initializeRuntimeStore, loadRuntimeStore } from '../src/runtime-store.ts';
import { RUNTIME_PROTOCOL_VERSION, type RuntimePrincipal } from '../src/runtime-protocol.ts';

const AT = '2026-07-23T22:00:00.000Z';
const AGENT: RuntimePrincipal = { id: 'agent-stdio', role: 'agent' };
const trajectory = (await compile(`
=== a ===
Alpha.
* [Go] -> b
=== b ===
Beta.
-> END
`)).trajectory!;

const collect = () => {
  let value = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  });
  return { stream, value: () => value };
};

const withStore = async (fn: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-runtime-process-'));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('stdio runtime processes correlated requests serially and emits lifecycle events', async () =>
  withStore(async (root) => {
    const snapshot = await initializeRuntimeStore(root, trajectory, {
      runId: 'stdio-1', at: AT, principal: AGENT,
    });
    const service = new RuntimeService(trajectory, snapshot, root, AGENT);
    const output = collect();
    const diagnostics = collect();
    const request = (value: Record<string, unknown>) =>
      `${JSON.stringify({ protocol: RUNTIME_PROTOCOL_VERSION, ...value })}\n`;
    const input = Readable.from([
      request({ id: 1, op: 'initialize', client: { name: 'test-host', version: '1' } }),
      request({ id: 2, op: 'next', profile: 'signal' }),
      request({
        id: 3,
        op: 'choose',
        choiceId: 'a#0',
        rationale: 'alpha complete',
        expectedRevision: 0,
        idempotencyKey: 'turn-1',
        profile: 'signal',
      }),
      request({ id: 4, op: 'events', after: 2, limit: 10 }),
    ]);

    await serveRuntimeLines(service, {
      input,
      output: output.stream,
      diagnostics: diagnostics.stream,
    });

    const messages = output.value().trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(messages[0].id, 1);
    assert.equal(messages[0].result.capabilities.eventCursor, true);
    assert.equal(messages[1].id, 2);
    assert.equal(messages[1].result.projection.node.id, 'a');
    assert.equal(messages[2].id, 3);
    assert.equal(messages[2].result.projection.node.id, 'b');
    assert.equal(messages[3].type, 'event');
    assert.equal(messages[3].event.kind, 'decision.committed');
    assert.equal(messages[4].type, 'event');
    assert.equal(messages[4].event.kind, 'node.entered');
    assert.equal(messages[5].id, 4);
    assert.equal(messages[5].result.events.length, 2);
    assert.match(diagnostics.value(), /Marionette stopped · revision 1/);

    const reopened = await loadRuntimeStore(root, 'stdio-1', trajectory);
    assert.equal(reopened.state.current, 'b');
    assert.equal(reopened.revision, 1);
  }));

test('stdio runtime requires initialization and returns errors without mutation', async () =>
  withStore(async (root) => {
    const snapshot = await initializeRuntimeStore(root, trajectory, { runId: 'stdio-2', at: AT });
    const service = new RuntimeService(trajectory, snapshot, root, AGENT);
    const output = collect();
    await serveRuntimeLines(service, {
      input: Readable.from([
        '{"protocol":"0.3.0","id":1,"op":"next"}\n',
        '{not json}\n',
      ]),
      output: output.stream,
    });
    const messages = output.value().trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(messages[0].error.code, 'invalid-request');
    assert.match(messages[0].error.message, /initialize/);
    assert.equal(messages[1].id, null);
    assert.equal(service.currentSnapshot().revision, 0);
  }));
