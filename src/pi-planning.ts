import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  CONFIG_DIR_NAME,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import {
  type MarionettePiApproveDraftRequest,
  type MarionettePiBindRequest,
  type MarionettePiDraft,
  type MarionettePiEvent,
  type MarionettePiExecution,
  type MarionettePiStartDraftRequest,
} from './pi-integration.ts';

const DRAFT_REVIEW_ENTRY = 'marionette-plan-review';
const EXECUTION_ENTRY = 'marionette-execution';
const LEGACY_EXECUTION_ENTRY = 'pibarm-marionette-execution';
const CONTINUATION_ENTRY = 'marionette-continuation';
const CONTINUATION_COMMAND = 'marionette-continue-session';
const TARGET_SELECTION_COMMAND = 'marionette-select-execution-target';
const APPROVAL_CHOICES = {
  worktree: 'Continue in a worktree',
  active: 'Continue in the active checkout',
  newSession: 'Continue in a new session',
  refine: 'Make changes to the plan',
} as const;

const PLANNING_DISABLED_TOOLS = new Set([
  'edit',
  'write',
  'marionette_amend',
  'marionette_rebind',
  'marionette_extend',
  'marionette_walk',
  'work_packet',
]);

const SIMPLE_READ_SEGMENT = /^(pwd|ls|rg|grep|cat|head|tail|wc)(?:\s|$)/;
const READ_ONLY_GIT_SEGMENT =
  /^(?:git\s+(?:status|diff|log|show|rev-parse)(?:\s|$)|git\s+worktree\s+list(?:\s|$)|git\s+branch(?:\s+(?:-a|-r|-v|-vv|--list|--show-current))?\s*$)/;

function isReadOnlySegment(segment: string): boolean {
  if (SIMPLE_READ_SEGMENT.test(segment)) {
    return !/^rg(?:\s|$)/.test(segment) || !/(?:^|\s)--(?:pre|hostname-bin)(?:=|\s|$)/.test(segment);
  }
  if (!READ_ONLY_GIT_SEGMENT.test(segment)) return false;
  return !/(?:^|\s)--(?:output|ext-diff|textconv)(?:=|\s|$)/.test(segment);
}

export function isReadOnlyPlanningCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (/[`<>]|\$\(/.test(trimmed)) return false;
  return trimmed
    .split(/[\n;&|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .every(isReadOnlySegment);
}

function slug(value: string, limit = 48): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit) || 'workflow';
}

export function summarizedWorktreeName(value: string): string {
  const words = value
    .replace(/\.[^.]+$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  return slug(words.join('-'), 40);
}

function planName(prompt: string): string {
  return summarizedWorktreeName(prompt);
}

export function isContinuationWorkRequest(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || /^(?:thanks|thank you|ok(?:ay)?|great|nice|done|looks good)[.!]*$/i.test(text)) {
    return false;
  }
  if (/^(?:what|why|how|when|where|who|which|did|does|is|are|was|were)\b.*\?$/i.test(text)) {
    return false;
  }
  // ponytail: conservative verb routing; replace with a host intent signal if false positives matter.
  return /\b(?:add|apply|build|change|check|clean|configure|continue|create|debug|delete|deploy|design|document|extend|find|fix|help|implement|investigate|make|migrate|move|open|optimize|patch|publish|rebind|refactor|release|remove|rename|resolve|review|run|set|ship|simplify|test|update|upgrade|verify|write)\b/i.test(text);
}

interface PendingContinuation {
  prompt: string;
  parentSession?: string;
  planFile: string;
  runId: string;
  executionRoot: string;
  handled: boolean;
  queued: boolean;
}

function continuationPrompt(pending: PendingContinuation): string {
  return [
    'Continue this additional work after a completed Marionette run.',
    '',
    '## Additional request',
    pending.prompt,
    '',
    '## Completed context',
    `- Plan: ${pending.planFile}`,
    `- Run: ${pending.runId} (completed; preserve its history)`,
    `- Execution root: ${pending.executionRoot}`,
    '',
    'Author a successor workflow for only the additional request; do not rewrite the completed run.',
  ].join('\n');
}

function latestEntry<T>(ctx: ExtensionContext, customTypes: string[]): T | undefined {
  const entry = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find((candidate) => candidate.type === 'custom' && customTypes.includes(candidate.customType));
  return entry?.type === 'custom' ? entry.data as T | undefined : undefined;
}

function latestDraft(ctx: ExtensionContext): MarionettePiDraft | null {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === DRAFT_REVIEW_ENTRY) return entry.data as MarionettePiDraft;
    if (entry.customType === 'marionette-event') {
      const event = entry.data as MarionettePiEvent;
      if (event.kind === 'plan.drafted' && event.draft) return event.draft;
    }
  }
  return null;
}

function reviewMarkdown(draft: MarionettePiDraft): string {
  const resources = draft.resources;
  const resourceLines = [
    resources?.svg?.path ? `- SVG graph: \`${resources.svg.path}\`` : null,
    resources?.mermaid?.path ? `- Mermaid source: \`${resources.mermaid.path}\`` : null,
    `- Plan source: \`${draft.planFile}\``,
  ].filter((line): line is string => Boolean(line)).join('\n');
  const compact = draft.compact
    ? `\n\n## Compact graph\n\n\`\`\`text\n${draft.compact}\n\`\`\``
    : '';
  return `${draft.summary}${compact}\n\n## Review artifacts\n\n${resourceLines}`;
}

function approvalPrompt(draft: MarionettePiDraft): string {
  const intent = /^\*\*Intent:\*\*\s*(.+)$/m.exec(draft.summary)?.[1];
  const shape = /^Starts at .+$/m.exec(draft.summary)?.[0];
  return [
    'How should this plan continue?',
    `Plan: ${draft.name ?? basename(draft.planFile, '.mar')}`,
    intent ? `Intent: ${intent.length > 200 ? `${intent.slice(0, 199)}…` : intent}` : '',
    shape ?? '',
    `Full review: ${draft.planFile}`,
  ].filter(Boolean).join('\n');
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10_000 });
  const root = result.stdout.trim();
  if (result.code !== 0 || !root) throw new Error(result.stderr || 'Not inside a git repository');
  return root;
}

interface Worktree {
  root: string;
  path: string;
  branch: string;
}

async function currentLinkedWorktree(pi: ExtensionAPI, cwd: string): Promise<Worktree | null> {
  const root = await gitRoot(pi, cwd);
  const [gitDirectory, commonDirectory] = await Promise.all([
    pi.exec('git', ['-C', root, 'rev-parse', '--git-dir'], { timeout: 10_000 }),
    pi.exec('git', ['-C', root, 'rev-parse', '--git-common-dir'], { timeout: 10_000 }),
  ]);
  if (gitDirectory.code !== 0 || commonDirectory.code !== 0) {
    throw new Error(gitDirectory.stderr || commonDirectory.stderr || 'Could not inspect the current worktree.');
  }
  if (resolve(root, gitDirectory.stdout.trim()) === resolve(root, commonDirectory.stdout.trim())) return null;
  const branch = await pi.exec('git', ['-C', root, 'branch', '--show-current'], { timeout: 10_000 });
  return { root, path: root, branch: branch.stdout.trim() };
}

async function createWorktree(pi: ExtensionAPI, cwd: string, requested: string): Promise<Worktree> {
  const root = await gitRoot(pi, cwd);
  const name = slug(requested);
  const path = join(root, CONFIG_DIR_NAME, 'wt', name);
  const branch = `work/${name}`;
  await mkdir(join(root, CONFIG_DIR_NAME, 'wt'), { recursive: true });
  const listed = await pi.exec('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeout: 10_000 });
  if (listed.code === 0 && listed.stdout.split('\n').includes(`worktree ${path}`)) {
    return { root, path, branch };
  }
  let result = await pi.exec(
    'git',
    ['-C', root, 'worktree', 'add', '-b', branch, path, 'HEAD'],
    { timeout: 30_000 },
  );
  if (result.code !== 0 && /already exists/i.test(result.stderr)) {
    result = await pi.exec('git', ['-C', root, 'worktree', 'add', path, branch], { timeout: 30_000 });
  }
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'git worktree add failed');
  return { root, path, branch };
}

function githubCliVersion(output: string): [number, number, number] | null {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast([major, minor]: [number, number, number], requiredMajor: number, requiredMinor: number): boolean {
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

async function isGitHubWorktree(pi: ExtensionAPI, worktree: Worktree): Promise<boolean> {
  const remote = await pi.exec(
    'git',
    ['-C', worktree.root, 'remote', 'get-url', 'origin'],
    { timeout: 10_000 },
  );
  return remote.code === 0 && /(?:github\.com)[/:]/i.test(remote.stdout.trim());
}

async function enableGitHubStack(pi: ExtensionAPI, worktree: Worktree): Promise<void> {
  const versionResult = await pi.exec('gh', ['--version'], { timeout: 10_000 });
  const version = githubCliVersion(versionResult.stdout);
  if (versionResult.code !== 0 || !version || !atLeast(version, 2, 90)) {
    throw new Error('GitHub stacked PRs require GitHub CLI 2.90 or newer.');
  }

  const stackHelp = await pi.exec('gh', ['stack', '--help'], { cwd: worktree.path, timeout: 10_000 });
  if (stackHelp.code !== 0) {
    throw new Error(stackHelp.stderr || stackHelp.stdout || 'The gh stack extension is unavailable.');
  }

  const current = await pi.exec('gh', ['stack', 'view', '--json'], {
    cwd: worktree.path,
    timeout: 15_000,
  });
  if (current.code === 0) return;

  const remoteHead = await pi.exec(
    'git',
    ['-C', worktree.root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { timeout: 10_000 },
  );
  const activeBranch = await pi.exec(
    'git',
    ['-C', worktree.root, 'branch', '--show-current'],
    { timeout: 10_000 },
  );
  const base = remoteHead.code === 0
    ? remoteHead.stdout.trim().replace(/^origin\//, '')
    : activeBranch.stdout.trim();
  if (!base || base === worktree.branch) {
    throw new Error('Could not determine the trunk branch for gh stack init.');
  }

  const initialized = await pi.exec(
    'gh',
    ['stack', 'init', worktree.branch, '--base', base],
    { cwd: worktree.path, timeout: 30_000 },
  );
  if (initialized.code !== 0 && !/already (?:exists|initialized|in a stack)/i.test(initialized.stderr)) {
    throw new Error(initialized.stderr || initialized.stdout || 'gh stack init failed.');
  }
}

interface PlanningOptions {
  getBinding(): { planFile: string; runId: string } | null;
  isCompleted(): boolean;
  bind(request: MarionettePiBindRequest): Promise<MarionettePiEvent>;
  execute(command: Record<string, unknown>): Promise<MarionettePiEvent>;
  onEvent(event: MarionettePiEvent): void;
}

export interface MarionettePiPlanningController {
  acceptDraft(draft: MarionettePiDraft, ctx: ExtensionContext): void;
  getDraft(): MarionettePiDraft | null;
  getExecution(): MarionettePiExecution | null;
  startDraft(request: MarionettePiStartDraftRequest): Promise<void>;
  show(ctx: ExtensionCommandContext): Promise<void>;
  approve(request: MarionettePiApproveDraftRequest, ctx: ExtensionCommandContext): Promise<void>;
  refine(feedback: string, ctx: ExtensionCommandContext): Promise<void>;
  refreshTools(): void;
  sessionStart(ctx: ExtensionContext): void;
  sessionTree(ctx: ExtensionContext): void;
  shutdown(): void;
}

export function registerMarionettePlanning(
  pi: ExtensionAPI,
  options: PlanningOptions,
  { genericSurface = true }: { genericSurface?: boolean } = {},
): MarionettePiPlanningController {
  let context: ExtensionContext | null = null;
  let planning = false;
  let toolsBeforePlanning: string[] | null = null;
  let draftPath = '';
  let pendingDraft: MarionettePiDraft | null = null;
  let execution: MarionettePiExecution | null = null;
  let approvalPrompted = '';
  let pendingContinuation: PendingContinuation | null = null;

  const setRuntimeTools = (): void => {
    const binding = options.getBinding();
    if (binding && planning) {
      planning = false;
      if (toolsBeforePlanning) pi.setActiveTools(toolsBeforePlanning);
      toolsBeforePlanning = null;
      context?.ui.setStatus('marionette-plan', undefined);
    }
    const active = pi.getActiveTools().filter((name) =>
      name !== 'marionette_draft' && name !== 'marionette_walk' &&
      name !== 'marionette_amend' && name !== 'marionette_rebind' &&
      name !== 'marionette_extend' && name !== 'work_packet');
    if (planning) active.push('marionette_draft');
    else if (binding && options.isCompleted()) {
      active.push('marionette_rebind', 'marionette_extend');
    } else if (binding) {
      active.push('work_packet', 'marionette_amend');
    }
    pi.setActiveTools([...new Set(active)]);
  };

  const restoredExecution = (ctx: ExtensionContext): MarionettePiExecution | null => {
    const candidate = latestEntry<MarionettePiExecution>(
      ctx,
      [EXECUTION_ENTRY, LEGACY_EXECUTION_ENTRY],
    );
    const binding = options.getBinding();
    if (!candidate || (binding && candidate.planFile !== binding.planFile)) return null;
    return {
      ...candidate,
      target: candidate.target ?? (candidate.executionRoot === ctx.cwd ? 'active' : 'worktree'),
      branching: candidate.branching ?? 'standard',
    };
  };

  const localPlanPath = (ctx: ExtensionContext, prompt: string): string => join(
    ctx.cwd,
    CONFIG_DIR_NAME,
    'marionette',
    'plans',
    `${planName(prompt)}-${ctx.sessionManager.getSessionId().slice(0, 8)}.mar`,
  );

  const enablePlanning = (ctx: ExtensionContext, path?: string): void => {
    context = ctx;
    if (!toolsBeforePlanning) toolsBeforePlanning = pi.getActiveTools();
    planning = true;
    if (path) draftPath = path;
    const inspectionTools = toolsBeforePlanning.filter((name) => !PLANNING_DISABLED_TOOLS.has(name));
    pi.setActiveTools([...new Set([...inspectionTools, 'marionette_draft'])]);
    ctx.ui.setStatus('marionette-plan', 'drafting workflow');
  };

  const disablePlanning = (ctx: ExtensionContext): void => {
    planning = false;
    if (toolsBeforePlanning) pi.setActiveTools(toolsBeforePlanning);
    toolsBeforePlanning = null;
    ctx.ui.setStatus('marionette-plan', undefined);
    setRuntimeTools();
  };

  const startDraft = async (request: MarionettePiStartDraftRequest): Promise<void> => {
    if (!context) throw new Error('The Pi session has not started.');
    if (options.getBinding()) throw new Error('A Marionette run is already bound.');
    const path = request.path ?? localPlanPath(context, request.prompt);
    pendingDraft = null;
    approvalPrompted = '';
    enablePlanning(context, path);
    if (request.triggerTurn !== false) {
      pi.sendUserMessage(
        `Author and validate a Marionette workflow for this task. Do not execute it yet.\n\n${request.prompt}`,
        { deliverAs: 'followUp' },
      );
    }
  };

  const show = async (ctx: ExtensionContext): Promise<void> => {
    if (options.getBinding()) {
      const next = await options.execute({ operation: 'next' });
      options.onEvent(next);
      const history = await options.execute({ operation: 'events', after: 0, limit: 20 });
      ctx.ui.notify(
        `Execution root: ${execution?.executionRoot ?? ctx.cwd}\n\n${JSON.stringify(next.projection ?? next, null, 2)}\n\nRecent events:\n${JSON.stringify(history, null, 2)}`,
        'info',
      );
      return;
    }
    if (pendingDraft) {
      pi.appendEntry(DRAFT_REVIEW_ENTRY, pendingDraft);
      const svg = pendingDraft.resources?.svg?.path;
      ctx.ui.notify(svg ? `Plan review shown. SVG: ${svg}` : 'Plan review shown.', 'info');
      return;
    }
    ctx.ui.notify('No Marionette draft or bound run.', 'info');
  };

  const approve = async (ctx: ExtensionContext, requestedTarget = 'worktree'): Promise<void> => {
    if (options.getBinding()) {
      ctx.ui.notify('A Marionette run is already bound.', 'warning');
      return;
    }
    if (!pendingDraft) {
      ctx.ui.notify('No validated Marionette plan is awaiting approval.', 'warning');
      return;
    }
    const draft = pendingDraft;
    const requested = requestedTarget.trim() || 'worktree';
    const target = requested === 'fresh' ? 'new-session' : requested;
    if (target === 'new-session') {
      const commandContext = ctx as ExtensionCommandContext;
      if (typeof commandContext.newSession !== 'function') {
        ctx.ui.notify('New-session approval must run through /approve-plan new-session.', 'error');
        return;
      }
      const parentSession = ctx.sessionManager.getSessionFile();
      try {
        const result = await commandContext.newSession({
          ...(parentSession ? { parentSession } : {}),
          async setup(session) {
            session.appendCustomEntry(DRAFT_REVIEW_ENTRY, draft);
          },
          withSession: async (next) => {
            await next.sendUserMessage(`/${TARGET_SELECTION_COMMAND}`);
          },
        });
        if (result.cancelled) {
          ctx.ui.notify('New-session handoff cancelled; the validated draft is still available here.', 'info');
        }
      } catch (error) {
        ctx.ui.notify(
          `New-session handoff failed; the validated draft is still available here: ${(error as Error).message}`,
          'error',
        );
      }
      return;
    }
    let executionRoot = ctx.cwd;
    let branching: MarionettePiExecution['branching'] = 'standard';
    if (target !== 'active') {
      const requestedName = summarizedWorktreeName(
        target.replace(/^worktree\s*/i, '').trim() ||
          draft.name ||
          basename(draft.planFile, '.mar'),
      );
      let worktree: Worktree;
      let enableStack = true;
      try {
        const current = await currentLinkedWorktree(pi, ctx.cwd);
        if (current) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              'Already in a linked worktree; choose whether to continue here or use a GitHub stack.',
              'error',
            );
            return;
          }
          const choice = await ctx.ui.select('This checkout is already a linked worktree', [
            'Continue in this worktree',
            'Use a GitHub stack in this worktree',
          ]);
          if (!choice) return;
          worktree = current;
          enableStack = choice === 'Use a GitHub stack in this worktree';
        } else {
          worktree = await createWorktree(pi, ctx.cwd, requestedName);
        }
        executionRoot = worktree.path;
      } catch (error) {
        ctx.ui.notify(`Could not prepare worktree execution: ${(error as Error).message}`, 'error');
        return;
      }

      if (enableStack && await isGitHubWorktree(pi, worktree)) {
        try {
          await enableGitHubStack(pi, worktree);
          branching = 'github-stack';
        } catch (error) {
          ctx.ui.notify(
            `GitHub stack setup failed; continuing with a normal worktree: ${(error as Error).message}`,
            'warning',
          );
        }
      }
    }
    const preparedExecution: MarionettePiExecution = {
      planFile: draft.planFile,
      graphHash: draft.graphHash,
      executionRoot,
      target: target === 'active' ? 'active' : 'worktree',
      branching,
    };

    execution = preparedExecution;
    pi.appendEntry(EXECUTION_ENTRY, execution);
    const event = await options.bind({
      planFile: draft.planFile,
      runId: `pi-${ctx.sessionManager.getSessionId()}`,
      triggerTurn: false,
    });
    options.onEvent(event);
    if (event.error) return;
    disablePlanning(ctx);
    pi.sendMessage({
      customType: 'marionette-approved',
      display: true,
      content: `The validated Marionette workflow is approved. Execute project changes only under ${executionRoot}.${branching === 'github-stack' ? ' GitHub stacked PRs are enabled: keep dependent layers in this worktree and use gh stack for stack operations.' : ''} The parent session owns traversal; delegated agents return evidence and must not advance the run. Call work_packet with operation=status for the current task.`,
      details: { execution, event },
    }, { deliverAs: 'followUp', triggerTurn: true });
  };

  const refine = async (ctx: ExtensionContext, feedback: string): Promise<void> => {
    if (!pendingDraft) {
      ctx.ui.notify('No pending Marionette draft.', 'warning');
      return;
    }
    if (!feedback.trim()) return;
    enablePlanning(ctx, pendingDraft.planFile);
    pi.sendUserMessage(
      `Revise the Marionette plan at ${pendingDraft.planFile} using this feedback. Read the existing source, call marionette_draft with overwrite=true, validate it, and do not execute it.\n\n${feedback.trim()}`,
      { deliverAs: 'followUp' },
    );
  };

  pi.registerEntryRenderer(DRAFT_REVIEW_ENTRY, (entry) => {
    const draft = entry.data as MarionettePiDraft;
    return new Markdown(reviewMarkdown(draft), 1, 0, getMarkdownTheme());
  });

  if (genericSurface) {
    pi.registerCommand('plan', {
      description: 'Author a validated Marionette workflow; use --project to keep it under plans/',
      handler: async (args, ctx) => {
        context = ctx;
        const project = /^--project\s+/i.test(args);
        const task = args.replace(/^--project\s+/i, '').trim();
        if (!task) return ctx.ui.notify('Usage: /plan [--project] <task>', 'warning');
        const path = project ? join(ctx.cwd, 'plans', `${planName(task)}.mar`) : undefined;
        try {
          await startDraft({ prompt: task, path, triggerTurn: true });
        } catch (error) {
          ctx.ui.notify((error as Error).message, 'warning');
        }
      },
    });

    pi.registerCommand('simple', {
      description: 'Bypass external automatic workflow routing for one request',
      handler: async (args, ctx) => {
        const task = args.trim();
        if (!task) return ctx.ui.notify('Usage: /simple <request>', 'warning');
        pi.sendUserMessage(task, { deliverAs: 'followUp' });
      },
    });

    pi.registerCommand('plan-mode', {
      description: 'Toggle Marionette draft mode',
      handler: async (_args, ctx) => planning ? disablePlanning(ctx) : enablePlanning(ctx),
    });

    for (const name of ['plan-show', 'marionette-show']) {
      pi.registerCommand(name, {
        description: name === 'plan-show'
          ? 'Show the current Marionette draft or run'
          : 'Show detailed Marionette plan or runtime state',
        handler: async (_args, ctx) => show(ctx),
      });
    }

    pi.registerCommand('approve-plan', {
      description: 'Approve the validated plan; defaults to an isolated worktree',
      handler: async (args, ctx) => approve(ctx, args.trim() || 'worktree'),
    });
    pi.registerCommand('execute-plan', {
      description: 'Approve and execute the validated Marionette plan',
      handler: async (args, ctx) => approve(ctx, args.trim() || 'worktree'),
    });
    pi.registerCommand('refine-plan', {
      description: 'Refine the pending validated Marionette plan before approval',
      handler: async (args, ctx) => {
        const feedback = args.trim() || await ctx.ui.editor('Refine the Marionette plan', '') || '';
        await refine(ctx, feedback);
      },
    });
  }

  pi.registerCommand(TARGET_SELECTION_COMMAND, {
    description: 'Choose where an approved plan runs after a new-session handoff',
    handler: async (_args, ctx) => {
      if (!pendingDraft) {
        ctx.ui.notify('No validated Marionette plan is awaiting a target.', 'warning');
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify('Choose worktree or active checkout in an interactive session.', 'error');
        return;
      }
      const target = await ctx.ui.select('Where should the approved plan run?', [
        APPROVAL_CHOICES.worktree,
        APPROVAL_CHOICES.active,
      ]);
      if (target === APPROVAL_CHOICES.worktree) await approve(ctx, 'worktree');
      else if (target === APPROVAL_CHOICES.active) await approve(ctx, 'active');
    },
  });

  pi.registerCommand(CONTINUATION_COMMAND, {
    description: 'Move a queued post-completion request into a replacement managed session',
    handler: async (_args, ctx) => {
      const pending = pendingContinuation;
      if (!pending || !pending.queued || pending.handled) {
        ctx.ui.notify('No post-completion continuation is queued.', 'warning');
        return;
      }
      try {
        const result = await ctx.newSession({
          ...(pending.parentSession ? { parentSession: pending.parentSession } : {}),
          withSession: async (replacementCtx) => {
            await replacementCtx.sendUserMessage(`/plan ${continuationPrompt(pending)}`);
          },
        });
        if (result.cancelled) {
          pending.queued = false;
          ctx.ui.notify('Continuation session replacement was cancelled; this session is unchanged.', 'info');
        }
      } catch (error) {
        pending.queued = false;
        ctx.ui.notify(`Continuation session replacement failed: ${(error as Error).message}`, 'error');
      }
    },
  });

  pi.on('before_agent_start', (event, ctx) => {
    context = ctx;
    if (options.getBinding()) {
      setRuntimeTools();
      if (options.isCompleted()) {
        const binding = options.getBinding()!;
        pendingContinuation = isContinuationWorkRequest(event.prompt)
          ? {
              prompt: event.prompt,
              parentSession: ctx.sessionManager.getSessionFile(),
              planFile: binding.planFile,
              runId: binding.runId,
              executionRoot: execution?.executionRoot ?? ctx.cwd,
              handled: false,
              queued: false,
            }
          : null;
        return {
          systemPrompt: `${event.systemPrompt}\n\nThe bound Marionette run is complete. For a new work request, call marionette_rebind when an existing validated plan/run should take over, or author a complete successor .mar source and call marionette_extend to keep the additional work managed without rewriting completed history. Do not use marionette_amend after END. For ordinary questions or conversation about the completed work, answer normally without using either continuation tool. If neither continuation tool handles a new work request, the host will move that request into a replacement session after this turn. Execute project changes only under ${execution?.executionRoot ?? ctx.cwd}.`,
        };
      }
      pendingContinuation = null;
      return {
        systemPrompt: `${event.systemPrompt}\n\nA managed work packet is active. Call work_packet(status) for the current task. When that task is done, call work_packet(complete) exactly once with its human-readable outcome and an evidence-based summary. If the user changes scope or the executable future is wrong, read the bound .mar source and call marionette_amend with the complete revised source and rationale; it applies only a valid future-only change, so do not wait for a separate rebind or continue against stale instructions. When the user restores work the agent previously descoped, insert it as a prerequisite to the remaining future instead of rewriting the completed discovery or decision phase. The host owns routing and human checkpoints. Execute file changes under ${execution?.executionRoot ?? ctx.cwd}; delegated agents receive only the current task and return evidence.${execution?.branching === 'github-stack' ? ' Keep dependent GitHub review layers in this worktree and use gh stack for stack operations.' : ''}`,
      };
    }
    if (!planning) return;
    if (!draftPath) draftPath = localPlanPath(ctx, event.prompt);
    return {
      systemPrompt: `${event.systemPrompt}\n\nMARIONETTE DRAFT MODE IS ACTIVE. Do not mutate project files. Follow the loaded marionette-authoring skill and ask only graph-shape questions with more than one viable answer. Use the focused question tool for one question and elicit_plan_questions only for two or more; keep option labels short and never repeat the request or draft in an option. Call marionette_draft with a complete validated plan at ${draftPath}. Preserve the user's original wording in # prompt metadata. Do not bind or execute the plan; approval is a separate human step.`,
    };
  });

  pi.on('tool_call', (event) => {
    if (pendingContinuation &&
        (event.toolName === 'marionette_rebind' || event.toolName === 'marionette_extend')) {
      pendingContinuation.handled = true;
    }
    if (pendingContinuation && !pendingContinuation.handled) {
      if (['edit', 'write', 'marionette_amend', 'marionette_walk', 'work_packet'].includes(event.toolName)) {
        return {
          block: true,
          reason: 'The prior run is complete; rebind, extend, or let Marionette hand this work to a replacement session.',
        };
      }
      if (event.toolName === 'bash' &&
          !isReadOnlyPlanningCommand(String((event.input as { command?: unknown }).command ?? ''))) {
        return {
          block: true,
          reason: 'The prior run is complete; mutating shell work requires a managed continuation.',
        };
      }
    }
    if (!planning) return;
    if (PLANNING_DISABLED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: 'Marionette draft mode blocks project mutation and traversal, but keeps inspection and planning tools available.',
      };
    }
    if (event.toolName === 'bash' &&
      !isReadOnlyPlanningCommand(String((event.input as { command?: unknown }).command ?? ''))) {
      return { block: true, reason: 'Marionette draft mode blocks mutating shell commands.' };
    }
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (pendingContinuation) {
      if (pendingContinuation.handled || !options.getBinding() || !options.isCompleted()) {
        pendingContinuation = null;
      } else if (!pendingContinuation.queued) {
        pendingContinuation.queued = true;
        pi.appendEntry(CONTINUATION_ENTRY, {
          prompt: pendingContinuation.prompt,
          parentSession: pendingContinuation.parentSession,
          planFile: pendingContinuation.planFile,
          runId: pendingContinuation.runId,
          executionRoot: pendingContinuation.executionRoot,
          status: 'queued',
        });
        pi.sendUserMessage(`/${CONTINUATION_COMMAND}`, { deliverAs: 'followUp' });
        return;
      }
    }
    if (!genericSurface || !planning || !pendingDraft || !ctx.hasUI || approvalPrompted === pendingDraft.graphHash)
      return;
    approvalPrompted = pendingDraft.graphHash;
    const choice = await ctx.ui.select(approvalPrompt(pendingDraft), Object.values(APPROVAL_CHOICES));
    if (choice === APPROVAL_CHOICES.worktree) await approve(ctx, 'worktree');
    else if (choice === APPROVAL_CHOICES.active) await approve(ctx, 'active');
    else if (choice === APPROVAL_CHOICES.newSession) pi.sendUserMessage('/approve-plan new-session');
    else if (choice === APPROVAL_CHOICES.refine) {
      const feedback = await ctx.ui.editor('Refine the Marionette plan', '') ?? '';
      await refine(ctx, feedback);
    }
  });

  return {
    acceptDraft(draft, ctx) {
      context = ctx;
      pendingDraft = draft;
      draftPath = draft.planFile;
      approvalPrompted = '';
      ctx.ui.setStatus(
        'marionette-plan',
        `plan ready${draft.warnings ? ` · ${draft.warnings} warning(s)` : ''}`,
      );
      pi.appendEntry(DRAFT_REVIEW_ENTRY, draft);
    },
    getDraft: () => pendingDraft,
    getExecution: () => execution,
    startDraft,
    show,
    approve: (request, ctx) =>
      approve(ctx, request.target === 'worktree' && request.worktreeName
        ? `worktree ${request.worktreeName}`
        : request.target),
    refine: (feedback, ctx) => refine(ctx, feedback),
    refreshTools: setRuntimeTools,
    sessionStart(ctx) {
      context = ctx;
      pendingDraft = latestDraft(ctx);
      execution = restoredExecution(ctx);
      setRuntimeTools();
    },
    sessionTree(ctx) {
      context = ctx;
      pendingDraft = latestDraft(ctx);
      execution = restoredExecution(ctx);
      setRuntimeTools();
    },
    shutdown() {
      context = null;
      planning = false;
      toolsBeforePlanning = null;
      pendingContinuation = null;
    },
  };
}
