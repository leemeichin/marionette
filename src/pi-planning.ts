import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CONFIG_DIR_NAME,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import {
  type MarionettePiBindRequest,
  type MarionettePiDraft,
  type MarionettePiEvent,
  type MarionettePiExecution,
  type MarionettePiStartDraftRequest,
} from './pi-integration.ts';

const DRAFT_REVIEW_ENTRY = 'marionette-plan-review';
const EXECUTION_ENTRY = 'marionette-execution';
const LEGACY_EXECUTION_ENTRY = 'pibarm-marionette-execution';

const PLANNING_DISABLED_TOOLS = new Set(['edit', 'write', 'marionette_amend', 'marionette_walk', 'work_packet']);

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

  let stackHelp = await pi.exec('gh', ['stack', '--help'], { cwd: worktree.path, timeout: 10_000 });
  if (stackHelp.code !== 0) {
    const installed = await pi.exec(
      'gh',
      ['extension', 'install', 'github/gh-stack'],
      { cwd: worktree.path, timeout: 60_000 },
    );
    if (installed.code !== 0 && !/already exists|already installed/i.test(installed.stderr)) {
      throw new Error(installed.stderr || installed.stdout || 'Could not install github/gh-stack.');
    }
    stackHelp = await pi.exec('gh', ['stack', '--help'], { cwd: worktree.path, timeout: 10_000 });
    if (stackHelp.code !== 0) {
      throw new Error(stackHelp.stderr || stackHelp.stdout || 'The gh stack extension is unavailable.');
    }
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
  bind(request: MarionettePiBindRequest): Promise<MarionettePiEvent>;
  execute(command: Record<string, unknown>): Promise<MarionettePiEvent>;
  onEvent(event: MarionettePiEvent): void;
}

export interface MarionettePiPlanningController {
  acceptDraft(draft: MarionettePiDraft, ctx: ExtensionContext): void;
  getDraft(): MarionettePiDraft | null;
  getExecution(): MarionettePiExecution | null;
  startDraft(request: MarionettePiStartDraftRequest): Promise<void>;
  refreshTools(): void;
  sessionStart(ctx: ExtensionContext): void;
  sessionTree(ctx: ExtensionContext): void;
  shutdown(): void;
}

export function registerMarionettePlanning(
  pi: ExtensionAPI,
  options: PlanningOptions,
): MarionettePiPlanningController {
  let context: ExtensionContext | null = null;
  let planning = false;
  let toolsBeforePlanning: string[] | null = null;
  let draftPath = '';
  let pendingDraft: MarionettePiDraft | null = null;
  let execution: MarionettePiExecution | null = null;
  let approvalPrompted = '';
  let githubStackPreference: boolean | null = null;

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
      name !== 'marionette_amend' && name !== 'work_packet');
    if (planning) active.push('marionette_draft');
    else if (binding) active.push('work_packet');
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
    const target = requestedTarget.trim() || 'worktree';
    let executionRoot = ctx.cwd;
    let branching: MarionettePiExecution['branching'] = 'standard';
    if (target !== 'active') {
      const requestedName = summarizedWorktreeName(
        target.replace(/^worktree\s*/i, '').trim() ||
          pendingDraft.name ||
          basename(pendingDraft.planFile, '.mar'),
      );
      let worktree: Worktree;
      try {
        worktree = await createWorktree(pi, ctx.cwd, requestedName);
        executionRoot = worktree.path;
      } catch (error) {
        ctx.ui.notify(`Could not create worktree: ${(error as Error).message}`, 'error');
        return;
      }

      if (await isGitHubWorktree(pi, worktree)) {
        if (githubStackPreference === null) {
          githubStackPreference = ctx.hasUI && await ctx.ui.confirm(
            'GitHub stacked PRs',
            'Enable GitHub stacked PRs inside this worktree? This may install the official github/gh-stack extension.',
          );
        }
        if (githubStackPreference) {
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
    }
    execution = {
      planFile: pendingDraft.planFile,
      graphHash: pendingDraft.graphHash,
      executionRoot,
      target: target === 'active' ? 'active' : 'worktree',
      branching,
    };
    pi.appendEntry(EXECUTION_ENTRY, execution);
    const event = await options.bind({
      planFile: pendingDraft.planFile,
      runId: `pi-${ctx.sessionManager.getSessionId()}`,
      triggerTurn: false,
    });
    options.onEvent(event);
    if (event.error) return;
    disablePlanning(ctx);
    pi.sendMessage({
      customType: 'marionette-approved',
      display: true,
      content: `The validated Marionette workflow is approved. Execute project changes only under ${executionRoot}.${branching === 'github-stack' ? ' GitHub stacked PRs are enabled: keep dependent layers in this worktree and use gh stack for stack operations.' : ''} The parent session owns traversal; delegated agents return evidence and must not advance the run.\n\n${JSON.stringify(event.projection ?? {})}`,
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

  pi.on('before_agent_start', (event, ctx) => {
    context = ctx;
    if (options.getBinding()) {
      setRuntimeTools();
      return {
        systemPrompt: `${event.systemPrompt}\n\nA managed work packet is active. Call work_packet(status) for the current task. When that task is done, call work_packet(complete) exactly once with its human-readable outcome and an evidence-based summary. The host owns routing and all human intervention. Execute file changes under ${execution?.executionRoot ?? ctx.cwd}; delegated agents receive only the current task and return evidence.${execution?.branching === 'github-stack' ? ' Keep dependent GitHub review layers in this worktree and use gh stack for stack operations.' : ''}`,
      };
    }
    if (!planning) return;
    if (!draftPath) draftPath = localPlanPath(ctx, event.prompt);
    return {
      systemPrompt: `${event.systemPrompt}\n\nMARIONETTE DRAFT MODE IS ACTIVE. Do not mutate project files. Follow the loaded marionette-authoring skill, ask at most one round of graph-shape questions when genuinely needed, and call marionette_draft with a complete validated plan at ${draftPath}. Preserve the user's original wording in # prompt metadata. Do not bind or execute the plan; approval is a separate human step.`,
    };
  });

  pi.on('tool_call', (event) => {
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
    if (!planning || !pendingDraft || !ctx.hasUI || approvalPrompted === pendingDraft.graphHash) return;
    approvalPrompted = pendingDraft.graphHash;
    const choice = await ctx.ui.select('Validated Marionette plan — review is shown above', [
      'Approve and execute in a worktree',
      'Approve and execute in the active checkout',
      'Refine before approval',
      'Keep for later',
    ]);
    if (choice === 'Approve and execute in a worktree') await approve(ctx, 'worktree');
    else if (choice === 'Approve and execute in the active checkout') await approve(ctx, 'active');
    else if (choice === 'Refine before approval') {
      const feedback = await ctx.ui.editor('Refine the Marionette plan', '') ?? '';
      await refine(ctx, feedback);
    } else disablePlanning(ctx);
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
    },
  };
}
