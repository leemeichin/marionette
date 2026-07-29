import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import marionetteExtension from '../src/pi-extension.ts';
import {
  MARIONETTE_PI_DISCOVER_CHANNEL,
  MARIONETTE_PI_EVENT_CHANNEL,
  MARIONETTE_PI_HUMAN_CHANNEL,
  type MarionettePiEvent,
  type MarionettePiHostApi,
} from '../src/pi-integration.ts';

interface CustomEntry {
  type: 'custom';
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
}

const createFakePi = (cwd: string) => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted = new Map<string, unknown[]>();
  const entries: CustomEntry[] = [];
  const messages: unknown[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  let activeBranch: CustomEntry[] = [];
  let sequence = 0;
  const tools = new Map<string, any>();

  const events = {
    emit(channel: string, data: unknown) {
      const values = emitted.get(channel) ?? [];
      values.push(data);
      emitted.set(channel, values);
      for (const handler of eventHandlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const values = eventHandlers.get(channel) ?? new Set();
      values.add(handler);
      eventHandlers.set(channel, values);
      return () => values.delete(handler);
    },
  };

  const sessionManager = {
    getSessionId: () => 'session-test',
    getBranch: () => [...activeBranch],
  };
  const ui = {
    setStatus() {},
    setWidget() {},
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
  };
  const ctx = {
    cwd,
    hasUI: false,
    ui,
    sessionManager,
  } as unknown as ExtensionContext;

  const pi = {
    events,
    registerFlag() {},
    getFlag: () => undefined,
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: any) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    appendEntry(customType: string, data?: unknown) {
      const entry: CustomEntry = {
        type: 'custom',
        id: `entry-${++sequence}`,
        parentId: activeBranch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      };
      entries.push(entry);
      activeBranch.push(entry);
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
  };

  marionetteExtension(pi as unknown as ExtensionAPI);

  return {
    commands,
    ctx,
    entries,
    emitted,
    eventBus: events,
    handlers,
    messages,
    notifications,
    tools,
    get tool() {
      return tools.get('marionette_walk');
    },
    branch: () => [...activeBranch],
    useBranch(branch: CustomEntry[]) {
      activeBranch = [...branch];
    },
    async fire(name: string, event: unknown) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    discover(): MarionettePiHostApi {
      let api: MarionettePiHostApi | undefined;
      events.emit(MARIONETTE_PI_DISCOVER_CHANNEL, {
        respond(value: MarionettePiHostApi) {
          api = value;
        },
      });
      assert.ok(api);
      return api;
    },
  };
};

const writePlan = (root: string, name: string, title: string): string => {
  const file = join(root, name);
  writeFileSync(file, `
=== start ===
${title}
* [Done] -> END
`, 'utf8');
  return file;
};

test('Pi extension restores bindings from the active branch and publishes a typed host API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-'));
  try {
    writePlan(root, 'a.mar', 'Plan A.');
    writePlan(root, 'b.mar', 'Plan B.');
    const fake = createFakePi(root);
    const api = fake.discover();
    assert.equal(api.protocol, '1.1.0');
    assert.equal(fake.tool.executionMode, 'sequential');
    assert.match(fake.tool.promptGuidelines.join('\n'), /instead of marionette brief/);
    await fake.fire('session_start', { reason: 'startup' });
    assert.deepEqual(fake.entries, []);

    await fake.commands.get('marionette-start')!.handler('a.mar run-a', fake.ctx);
    const branchA = fake.branch();
    assert.equal(api.getBinding()?.runId, 'run-a');
    assert.equal(api.getBinding()?.planFile, join(root, 'a.mar'));

    fake.useBranch([]);
    await fake.commands.get('marionette-start')!.handler('b.mar run-b', fake.ctx);
    assert.equal(api.getBinding()?.runId, 'run-b');

    fake.useBranch(branchA);
    await fake.fire('session_tree', { type: 'session_tree' });
    assert.equal(api.getBinding()?.runId, 'run-a');

    const unbound = await api.unbind();
    assert.equal(unbound.kind, 'binding.unbound');
    assert.equal(api.getBinding(), null);
    await fake.fire('session_tree', { type: 'session_tree' });
    assert.equal(api.getBinding(), null);

    const rebound = await api.bind({ planFile: 'a.mar', runId: 'run-host' });
    assert.equal(rebound.kind, 'binding.bound');
    assert.equal(api.getBinding()?.runId, 'run-host');

    const events = fake.emitted.get(MARIONETTE_PI_EVENT_CHANNEL) as MarionettePiEvent[];
    assert.ok(events.some((event) => event.kind === 'binding.bound'));
    assert.ok(fake.entries.some((entry) => entry.customType === 'marionette-event'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi extension draft tool validates before atomically writing and emits an event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-draft-'));
  try {
    const fake = createFakePi(root);
    await fake.fire('session_start', { reason: 'startup' });
    const draft = fake.tools.get('marionette_draft');
    const planFile = join(root, 'plans', 'draft.mar');

    const invalid = await draft.execute(
      'draft-invalid',
      { path: 'plans/draft.mar', source: '=== broken ===\nNo exit.\n' },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(invalid.details.ok, false);
    assert.equal(existsSync(planFile), false);

    const source = '=== start ===\nDo the work.\n* [Done] -> END\n';
    const valid = await draft.execute(
      'draft-valid',
      { path: 'plans/draft.mar', source },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(valid.details.ok, true);
    assert.equal(readFileSync(planFile, 'utf8'), source);
    assert.match(valid.details.summary, /Plan summary/);
    assert.match(valid.details.mermaid, /flowchart/);

    await assert.rejects(() => draft.execute(
      'draft-existing',
      { path: 'plans/draft.mar', source },
      undefined,
      undefined,
      fake.ctx,
    ), /EEXIST/);

    const revised = source.replace('Do the work.', 'Do the revised work.');
    await draft.execute(
      'draft-revised',
      { path: 'plans/draft.mar', source: revised, overwrite: true },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(readFileSync(planFile, 'utf8'), revised);
    const events = fake.emitted.get(MARIONETTE_PI_EVENT_CHANNEL) as MarionettePiEvent[];
    assert.equal(events.filter((event) => event.kind === 'plan.drafted').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi extension tool exposes record/events receipts and structured failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-tool-'));
  try {
    writePlan(root, 'plan.mar', 'Tool contract.');
    const fake = createFakePi(root);
    await fake.commands.get('marionette-start')!.handler('plan.mar run-tool', fake.ctx);

    const record = await fake.tool.execute(
      'tool-record',
      {
        operation: 'record',
        recordKind: 'note',
        summary: 'Host-visible note',
        rationale: 'integration test',
      },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(record.isError, undefined);
    assert.equal(record.details.operation, 'record');
    assert.equal(record.details.events[0].kind, 'record.attached');
    assert.equal(record.details.receipt.eventSeqs.length, 1);

    const history = await fake.tool.execute(
      'tool-events',
      { operation: 'events', after: 0, limit: 20 },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(history.details.operation, 'events');
    assert.ok(history.details.result.events.length >= 3);

    const invalid = await fake.tool.execute(
      'tool-invalid',
      { operation: 'choose' },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(invalid.isError, true);
    assert.equal(invalid.details.error.code, 'invalid-request');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi host API keeps human authority outside the model tool surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-human-'));
  try {
    writeFileSync(join(root, 'approval.mar'), `
=== approval ===
Human approval required.
* [Approve] @human -> END
`, 'utf8');
    const fake = createFakePi(root);
    await fake.commands.get('marionette-start')!.handler(
      'approval.mar run-human',
      fake.ctx,
    );
    const api = fake.discover();

    const forbidden = await fake.tool.execute(
      'tool-human',
      {
        operation: 'choose',
        choiceId: 'approval#0',
        rationale: 'the model cannot approve itself',
      },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(forbidden.isError, true);
    assert.equal(forbidden.details.error.code, 'forbidden');

    fake.eventBus.on(MARIONETTE_PI_HUMAN_CHANNEL, (value) => {
      (value as { respond(humanId: string): void }).respond('user-42');
    });
    await fake.commands.get('marionette-decide')!.handler(
      'approval#0 reviewed in pibarm',
      fake.ctx,
    );
    const approved = await api.execute({ operation: 'next' });
    assert.equal(approved.projection?.status, 'completed');
    const events = fake.emitted.get(MARIONETTE_PI_EVENT_CHANNEL) as MarionettePiEvent[];
    const decision = events.find((event) =>
      event.events?.some((item) => item.kind === 'decision.committed'));
    assert.equal(decision?.events?.[0].principal?.role, 'human');
    assert.equal(decision?.events?.[0].principal?.id, 'user-42');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
