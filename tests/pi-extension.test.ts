import { execFileSync } from 'node:child_process';
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

interface FakePiOptions {
  hasUI?: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
  select?: (title: string, choices: string[]) => Promise<string | undefined>;
  exec?: (command: string, args: string[], options?: { cwd?: string }) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
}

const createFakePi = (cwd: string, options: FakePiOptions = {}) => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted = new Map<string, unknown[]>();
  const entries: CustomEntry[] = [];
  const messages: unknown[] = [];
  const userMessages: string[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const entryRenderers = new Map<string, unknown>();
  const widgets = new Map<string, unknown>();
  let activeTools = [
    'read',
    'bash',
    'edit',
    'write',
    'custom_inspector',
    'marionette_draft',
    'marionette_walk',
    'work_packet',
  ];
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
    setWidget(name: string, value: unknown) {
      if (value === undefined) widgets.delete(name);
      else widgets.set(name, value);
    },
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
    select: options.select ?? (async () => undefined),
    confirm: options.confirm ?? (async () => false),
    input: async () => undefined,
    editor: async () => undefined,
  };
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? false,
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
    registerEntryRenderer(name: string, renderer: unknown) {
      entryRenderers.set(name, renderer);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(value: string[]) {
      activeTools = [...value];
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
    sendUserMessage(message: string) {
      userMessages.push(message);
    },
    async exec(command: string, args: string[], execOptions?: { cwd?: string }) {
      return options.exec?.(command, args, execOptions) ??
        { stdout: '', stderr: '', code: 1, killed: false };
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
    userMessages,
    notifications,
    entryRenderers,
    activeTools: () => [...activeTools],
    tools,
    widgets,
    get tool() {
      return tools.get('marionette_walk');
    },
    get workPacket() {
      return tools.get('work_packet');
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
    assert.equal(api.protocol, '1.6.0');
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

test('standalone Pi extension owns read-only draft mode and /plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-plan-mode-'));
  try {
    const fake = createFakePi(root);
    await fake.fire('session_start', { reason: 'startup' });
    await fake.commands.get('plan')!.handler('build and gate a rollout', fake.ctx);
    assert.ok(fake.activeTools().includes('marionette_draft'));
    assert.ok(!fake.activeTools().includes('edit'));
    assert.ok(fake.activeTools().includes('custom_inspector'));
    assert.match(fake.userMessages[0]!, /Do not execute it yet/);

    const before = (await (fake.handlers.get('before_agent_start') ?? [])[0]?.(
      { systemPrompt: 'base', prompt: 'task' },
      fake.ctx,
    )) as { systemPrompt: string };
    assert.match(before.systemPrompt, /MARIONETTE DRAFT MODE IS ACTIVE/);
    const planningToolHandler = (fake.handlers.get('tool_call') ?? [])[0]!;
    const allowed = await planningToolHandler(
      { toolName: 'custom_inspector', input: {} },
      fake.ctx,
    );
    assert.equal(allowed, undefined);
    const blocked = await planningToolHandler(
      { toolName: 'write', input: {} },
      fake.ctx,
    ) as { block: boolean };
    assert.equal(blocked.block, true);
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
    assert.match(valid.details.compact, /● start/);
    assert.match(readFileSync(valid.details.resources.svg.path, 'utf8'), /<svg/);
    assert.equal(existsSync(valid.details.resources.svg.path), true);
    assert.equal(existsSync(valid.details.resources.mermaid.path), true);
    assert.ok(fake.entries.some((entry) => entry.customType === 'marionette-plan-review'));

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

test('automatic plan approval shows the overview and high-level walkthrough beside the choices', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-review-'));
  const prompts: string[] = [];
  try {
    const fake = createFakePi(root, {
      hasUI: true,
      select: async (title) => {
        prompts.push(title);
        return 'Keep for later';
      },
    });
    await fake.fire('session_start', { reason: 'startup' });
    await fake.commands.get('plan')!.handler('Ship the smallest reviewed slice', fake.ctx);
    await fake.tools.get('marionette_draft').execute(
      'draft-review',
      {
        path: 'plans/review.mar',
        source: [
          '# summary: Ship a reviewed slice.',
          '# prompt: Ship the smallest reviewed slice',
          '=== start ===',
          'Build and verify the slice.',
          '* [Done] -> END',
          '',
        ].join('\n'),
      },
      undefined,
      undefined,
      fake.ctx,
    );

    await fake.fire('agent_settled', {});

    assert.match(prompts[0]!, /Ship a reviewed slice/);
    assert.match(prompts[0]!, /Ship the smallest reviewed slice/);
    assert.match(prompts[0]!, /High-level walkthrough:/);
    assert.match(prompts[0]!, /● start/);
    assert.match(prompts[0]!, /Plan source: .*review\.mar/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone approval binds a validated draft for active-checkout execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-approve-'));
  try {
    const fake = createFakePi(root);
    await fake.fire('session_start', { reason: 'startup' });
    const draft = fake.tools.get('marionette_draft');
    await draft.execute(
      'draft-approve',
      {
        path: 'plans/approve.mar',
        source: '=== start ===\nDo approved work.\n* [Done] -> END\n',
      },
      undefined,
      undefined,
      fake.ctx,
    );

    await fake.commands.get('approve-plan')!.handler('active', fake.ctx);
    const api = fake.discover();
    assert.equal(api.getBinding()?.planFile, join(root, 'plans', 'approve.mar'));
    assert.deepEqual(api.getExecution(), {
      planFile: join(root, 'plans', 'approve.mar'),
      graphHash: api.getBinding()?.graphHash,
      executionRoot: root,
      target: 'active',
      branching: 'standard',
    });
    assert.ok(fake.activeTools().includes('work_packet'));
    assert.equal(fake.activeTools().includes('marionette_walk'), false);
    assert.equal(fake.activeTools().includes('marionette_amend'), false);
    const approval = fake.messages.find((message) =>
      (message as { customType?: string }).customType === 'marionette-approved') as { content: string };
    assert.match(approval.content, /Call work_packet/);
    assert.doesNotMatch(approval.content, /\{"runId"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed work packets use outcome labels without exposing internal ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-packet-'));
  try {
    writePlan(root, 'packet.mar', 'Complete the managed task.');
    const fake = createFakePi(root);
    await fake.commands.get('marionette-start')!.handler('packet.mar run-packet', fake.ctx);

    const status = await fake.workPacket.execute(
      'packet-status',
      { operation: 'status' },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.match(status.content[0].text, /Complete the managed task/);
    assert.match(status.content[0].text, /"outcomes":\["Done"\]/);
    assert.doesNotMatch(status.content[0].text, /start#0|marionette/i);
    const rendered = fake.workPacket.renderResult(status).render(80).join('\n');
    assert.match(rendered, /start · active/);
    assert.match(rendered, /Outcomes: Done/);
    assert.doesNotMatch(rendered, /[{}\"]/);

    const completed = await fake.workPacket.execute(
      'packet-complete',
      { operation: 'complete', outcome: 'Done', summary: 'Task and checks completed.' },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(completed.details.projection.status, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktree approval can enable GitHub stacked PR branching once per session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-stack-'));
  const calls: string[] = [];
  let confirmations = 0;
  try {
    const fake = createFakePi(root, {
      hasUI: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
      exec: async (command, args) => {
        calls.push([command, ...args].join(' '));
        const joined = args.join(' ');
        if (command === 'git' && joined.includes('rev-parse --show-toplevel')) {
          return { stdout: `${root}\n`, stderr: '', code: 0, killed: false };
        }
        if (command === 'git' && joined.includes('worktree list --porcelain')) {
          return { stdout: '', stderr: '', code: 0, killed: false };
        }
        if (command === 'git' && joined.includes('worktree add')) {
          return { stdout: '', stderr: '', code: 0, killed: false };
        }
        if (command === 'git' && joined.includes('remote get-url origin')) {
          return { stdout: 'git@github.com:acme/project.git\n', stderr: '', code: 0, killed: false };
        }
        if (command === 'git' && joined.includes('symbolic-ref')) {
          return { stdout: 'origin/main\n', stderr: '', code: 0, killed: false };
        }
        if (command === 'git' && joined.includes('branch --show-current')) {
          return { stdout: 'main\n', stderr: '', code: 0, killed: false };
        }
        if (command === 'gh' && joined === '--version') {
          return { stdout: 'gh version 2.90.0 (test)\n', stderr: '', code: 0, killed: false };
        }
        if (command === 'gh' && joined === 'stack --help') {
          return { stdout: 'stack help\n', stderr: '', code: 0, killed: false };
        }
        if (command === 'gh' && joined === 'stack view --json') {
          return { stdout: '', stderr: 'not in a stack', code: 1, killed: false };
        }
        if (command === 'gh' && joined.includes('stack init')) {
          return { stdout: '', stderr: '', code: 0, killed: false };
        }
        return { stdout: '', stderr: 'unexpected command', code: 1, killed: false };
      },
    });
    await fake.fire('session_start', { reason: 'startup' });
    const draft = fake.tools.get('marionette_draft');
    await draft.execute(
      'draft-stack',
      {
        path: 'plans/stack.mar',
        source: '=== start ===\nDo stacked work.\n* [Done] -> END\n',
      },
      undefined,
      undefined,
      fake.ctx,
    );

    await fake.commands.get('approve-plan')!.handler('worktree stack-work', fake.ctx);
    assert.equal(confirmations, 1);
    assert.deepEqual(fake.discover().getExecution(), {
      planFile: join(root, 'plans', 'stack.mar'),
      graphHash: fake.discover().getBinding()?.graphHash,
      executionRoot: join(root, '.pi', 'wt', 'stack-work'),
      target: 'worktree',
      branching: 'github-stack',
    });
    assert.ok(calls.some((call) => call.includes(
      'gh stack init work/stack-work --base main',
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi extension persists future-only proposals and applies them only through trusted approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-amend-'));
  try {
    const planFile = join(root, 'plan.mar');
    const original = [
      '=== a ===',
      'Alpha.',
      '* [Go] -> b',
      '=== b ===',
      'Beta.',
      '-> END',
      '',
    ].join('\n');
    writeFileSync(planFile, original);
    const fake = createFakePi(root);
    await fake.commands.get('marionette-start')!.handler('plan.mar run-amend', fake.ctx);
    const api = fake.discover();
    const stepped = await api.execute({
      operation: 'choose',
      choiceId: 'a#0',
      rationale: 'alpha complete',
      idempotencyKey: 'alpha-complete',
    });
    const oldHash = stepped.binding!.graphHash;
    const forbiddenCandidate = original.replace('Alpha.', 'Alpha rewritten after completion.');
    const forbidden = await fake.tools.get('marionette_amend').execute(
      'tool-amend-forbidden',
      { source: forbiddenCandidate, rationale: 'attempt to rewrite history' },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /rewrite completed work/);
    assert.equal(readFileSync(planFile, 'utf8'), original);

    const candidate = [
      '=== a ===',
      'Alpha.',
      '* [Go] -> b',
      '=== b ===',
      'Beta updated before completion.',
      '-> c',
      '=== c ===',
      'New future work.',
      '-> END',
      '',
    ].join('\n');
    const proposed = await fake.tools.get('marionette_amend').execute(
      'tool-amend',
      { source: candidate, rationale: 'new work was discovered' },
      undefined,
      undefined,
      fake.ctx,
    );
    assert.equal(proposed.isError, undefined);
    assert.equal(readFileSync(planFile, 'utf8'), original, 'proposal does not mutate the live source');
    assert.equal(proposed.details.kind, 'plan.amendment-proposed');
    assert.equal(proposed.details.amendment.report.allowed, true);
    assert.ok(existsSync(proposed.details.amendment.candidateFile));
    assert.ok(existsSync(proposed.details.amendment.mermaidFile));
    assert.ok(existsSync(proposed.details.amendment.svgFile));
    assert.match(readFileSync(proposed.details.amendment.svgFile, 'utf8'), /<svg/);
    const amendmentPacket = fake.widgets.get('marionette-amendment') as string[];
    assert.match(amendmentPacket.join('\n'), /Why: new work was discovered/);
    assert.match(amendmentPacket.join('\n'), /phase-added: c/);
    assert.match(amendmentPacket.join('\n'), /SVG:/);

    const proposalBranch = fake.branch();
    fake.useBranch([]);
    await fake.fire('session_tree', { type: 'session_tree' });
    fake.useBranch(proposalBranch);
    await fake.fire('session_tree', { type: 'session_tree' });

    const approved = await api.approveAmendment({
      human: { id: 'lee', uri: 'pi://human/lee' },
      proposalId: proposed.details.amendment.id,
      rationale: 'reviewed the semantic diff and artifacts',
      triggerTurn: false,
    });
    assert.equal(approved.kind, 'plan.rebound');
    assert.equal(approved.events?.[0].kind, 'plan.rebound');
    assert.equal(approved.events?.[0].principal?.role, 'human');
    assert.equal(readFileSync(planFile, 'utf8'), candidate);
    assert.notEqual(api.getBinding()?.graphHash, oldHash);

    const history = await api.execute({ operation: 'events', after: 0, limit: 20 });
    const runtimeEvents = history.result?.events as Array<{ kind: string; graph: { trajectoryHash: string } }>;
    assert.equal(runtimeEvents.find((event) => event.kind === 'decision.committed')?.graph.trajectoryHash, oldHash);
    assert.equal(runtimeEvents.find((event) => event.kind === 'plan.rebound')?.graph.trajectoryHash,
      api.getBinding()?.graphHash);
    assert.equal(fake.tool.parameters.properties.operation.anyOf.some(
      (entry: { const?: string }) => entry.const === 'amend'), false, 'marionette_walk cannot approve amendments');
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

test('Pi human confirmations use the repository Git author and require evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-pi-extension-external-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Reviewing Maintainer'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: root });
    writeFileSync(join(root, 'external.mar'), `
# summary: Merge a reviewed pull request.
=== approval ===
Wait for a maintainer to confirm approval of PR #12.
* [Maintainer approved] @human -> END
`, 'utf8');
    const fake = createFakePi(root);
    await fake.commands.get('marionette-start')!.handler('external.mar run-external', fake.ctx);
    const api = fake.discover();
    const packet = fake.widgets.get('marionette-escalation') as string[];
    assert.match(packet.join('\n'), /Human confirmation required/);
    assert.match(packet.join('\n'), /Merge a reviewed pull request/);
    assert.match(packet.join('\n'), /Wait for a maintainer to confirm approval/);
    assert.match(packet.join('\n'), /high-risk checkpoint requires durable evidence/);
    assert.doesNotMatch(packet.join('\n'), /approval#0|marionette-confirm-human/);

    const noEvidence = await api.externalConfirm({
      external: { id: 'maintainer' },
      choiceId: 'approval#0',
      rationale: 'claimed approval',
      evidence: [],
      idempotencyKey: 'external-empty',
      triggerTurn: false,
    });
    assert.equal(noEvidence.error?.code, 'invalid-request');

    await fake.commands.get('marionette-confirm-human')!.handler(
      'approval#0 https://github.com/acme/repo/pull/12#pullrequestreview-1 approved PR #12',
      fake.ctx,
    );
    const confirmation = fake.entries.find(
      (entry) => entry.customType === 'marionette-external-confirmation',
    )?.data as { external?: { id?: string; uri?: string } } | undefined;
    assert.equal(confirmation?.external?.id, 'Reviewing Maintainer');
    assert.equal(confirmation?.external?.uri, 'mailto:reviewer@example.com');
    const completed = await fake.discover().execute({ operation: 'next' });
    assert.equal(completed.projection?.status, 'completed');
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
* [Approve] @ask -> END
`, 'utf8');
    const fake = createFakePi(root);
    await fake.commands.get('marionette-start')!.handler(
      'approval.mar run-human',
      fake.ctx,
    );
    const api = fake.discover();
    const packet = fake.widgets.get('marionette-escalation') as string[];
    assert.match(packet.join('\n'), /Operator decision required/);
    assert.match(packet.join('\n'), /Human approval required\./);
    assert.match(packet.join('\n'), /Approve/);
    assert.doesNotMatch(packet.join('\n'), /approval#0|marionette-decide/);

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
    const projectionMessage = fake.messages.find((message) =>
      (message as { customType?: string }).customType === 'marionette-projection') as { display: boolean };
    assert.equal(projectionMessage.display, false);
    const events = fake.emitted.get(MARIONETTE_PI_EVENT_CHANNEL) as MarionettePiEvent[];
    const decision = events.find((event) =>
      event.events?.some((item) => item.kind === 'decision.committed'));
    assert.equal(decision?.events?.[0].principal?.role, 'human');
    assert.equal(decision?.events?.[0].principal?.id, 'user-42');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
