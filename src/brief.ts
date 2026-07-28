/**
 * The work packet (Phase 2 ingestion): everything an executor agent needs to
 * act on the current phase with zero plan-specific prompt engineering (G2).
 *
 * `marionette brief` assembles the packet from the compiled trajectory and the
 * bound state: the phase's prose and external refs, the evaluated frontier,
 * the effective delivery config, and — when every available choice is a human
 * checkpoint — a structured escalation. The JSON form is the machine contract
 * (spec/brief.schema.json); the text form is for humans watching along.
 */

import type { Trajectory, TrajectoryNode, Ref, Value } from './types.js';
import { END } from './types.js';
import { enteredAt, frontier, visitedPath, type AvailableChoice } from './state.js';
import type { PlanState } from './types.js';
import {
  resolveDelivery, resolvePriority, resolveTimebox,
  type DeliveryConfig, type Priority, type Timebox,
} from './refs.js';
import type { Style } from './term.js';
import { styleFor } from './term.js';

export type BriefStatus =
  /** The executor can act: at least one autonomous step is available. */
  | 'active'
  /** Runtime values must be supplied before the frontier can be evaluated. */
  | 'awaiting-observation'
  /** No ordinary route is open yet; a timeout edge will open later. */
  | 'waiting-timeout'
  /** Only @human choices are available: escalate and pause. */
  | 'awaiting-human'
  /** Nothing is available and there is no automatic next step: the traversal is stuck. */
  | 'stranded'
  /** The plan reached END. */
  | 'completed';

export interface BriefChoice {
  index: number;
  id: string;
  label: string;
  target: string;
  /** First body line of the target phase (null for END). */
  targetTitle: string | null;
  sticky: boolean;
  human: boolean;
  loop: boolean;
  gate: string | null;
  available: boolean;
  blocked: string | null;
  blockedCode:
    | 'once-exhausted'
    | 'gate-blocked'
    | 'observation-required'
    | 'timeout-pending'
    | 'timed-out'
    | null;
  timeout: { source: string; seconds: number } | null;
}

export interface Escalation {
  reason: string;
  /** Choice ids a human must decide between. */
  choices: string[];
  /**
   * Graph-authored temporal exits that can end the wait. There is no
   * protocol-level timeout: an empty list means the checkpoint remains
   * parked until a human responds.
   */
  fallbacks: Array<{
    choice: string;
    label: string;
    target: string;
    dueAt: string | null;
  }>;
  how: string;
}

export interface Brief {
  spec: string;
  plan: {
    file: string;
    project: string | null;
    hash: string;
    refs: Ref[];
    /** Why this plan exists: # summary: (abstract) and # prompt: (original ask). */
    intent: { summary: string | null; prompt: string | null };
  };
  status: BriefStatus;
  variables: Record<string, Value>;
  /** Values the runtime is currently waiting for, with their declared types. */
  pendingObservations: Array<{ name: string; type: string }>;
  /** The current phase (null once the plan has completed). */
  node: {
    id: string;
    title: string;
    body: string;
    meta: Record<string, string | string[]>;
    refs: Ref[];
    /**
     * Advisory wall-clock budget (# timebox:). The walker never consults the
     * clock — consumers compare `enteredAt` to their own "now"; an overdue
     * timebox is evidence for the phase's abandon exit, not a transition.
     */
    timebox: Timebox | null;
    /** Executor ordering hint (# priority:), never a walker concern. */
    priority: Priority | null;
    /** When traversal entered this phase (from the decision log), or null. */
    enteredAt: string | null;
  } | null;
  /** Effective delivery config at this node (node tags override plan tags). */
  delivery: DeliveryConfig;
  frontier: BriefChoice[];
  next: { target: string; targetTitle: string | null } | null;
  /** Present exactly when status is "awaiting-human". */
  escalation: Escalation | null;
  progress: {
    steps: number;
    nodesVisited: number;
    nodesTotal: number;
    path: string[];
  };
  /** How to record the outcome — the executor's side of the protocol. */
  protocol: {
    choose: string;
    advance: string;
    observe: string;
    rules: string[];
  };
}

const title = (node: TrajectoryNode | undefined): string | null =>
  node ? (node.body.split('\n')[0] || node.id) : null;

const metaString = (v: string | string[] | undefined): string | null =>
  v === undefined ? null : Array.isArray(v) ? v[v.length - 1] : v;

// Repeated tags accumulate; for intent text every line matters, so join.
const metaText = (v: string | string[] | undefined): string | null =>
  v === undefined ? null : Array.isArray(v) ? v.join('\n') : v;

export interface BriefOptions {
  /** Plan path used in the protocol command templates. */
  file?: string;
  /** Evaluation time for syntactic timeout edges. */
  at?: string;
}

export async function buildBrief(
  trajectory: Trajectory,
  state: PlanState,
  options: BriefOptions = {},
): Promise<Brief> {
  const file = options.file ?? trajectory.source.file;
  const completed = state.status === 'completed';
  const node = completed ? undefined : trajectory.nodes.find((n) => n.id === state.current);
  const nodeById = (id: string) => trajectory.nodes.find((n) => n.id === id);

  const options_ = completed ? [] : await frontier(trajectory, state, { at: options.at });
  const choices: BriefChoice[] = options_.map((a: AvailableChoice, index: number) => ({
    index,
    id: a.choice.id,
    label: a.choice.label,
    target: a.choice.target,
    targetTitle: a.choice.target === END ? null : title(nodeById(a.choice.target)),
    sticky: a.choice.sticky,
    human: a.choice.human,
    loop: a.choice.loop,
    gate: a.choice.gate?.source ?? null,
    available: a.blocked === null,
    blocked: a.blocked,
    blockedCode: a.blockedCode,
    timeout: a.choice.timeout ?? null,
  }));

  const available = choices.filter((c) => c.available);
  const next = node?.next
    ? { target: node.next.target, targetTitle: node.next.target === END ? null : title(nodeById(node.next.target)) }
    : null;

  let status: BriefStatus = 'active';
  let escalation: Escalation | null = null;
  if (completed) {
    status = 'completed';
  } else if (state.pendingObservations.length > 0) {
    status = 'awaiting-observation';
  } else if (available.length === 0 && choices.some((c) => c.blockedCode === 'timeout-pending')) {
    status = 'waiting-timeout';
  } else if (available.length === 0 && !next) {
    status = 'stranded';
  } else if (available.length > 0 && available.every((c) => c.human)) {
    status = 'awaiting-human';
    const fallbacks = choices
      .filter((choice) => choice.blockedCode === 'timeout-pending' && choice.timeout)
      .map((choice) => {
        const activated = state.activationStartedAt === null
          ? Number.NaN
          : Date.parse(state.activationStartedAt);
        return {
          choice: choice.id,
          label: choice.label,
          target: choice.target,
          dueAt: Number.isFinite(activated)
            ? new Date(activated + choice.timeout!.seconds * 1_000).toISOString()
            : null,
        };
      });
    escalation = {
      reason: available.length === choices.length
        ? 'every choice at this phase is an @human checkpoint'
        : 'every currently-available choice is an @human checkpoint',
      choices: available.map((c) => c.id),
      fallbacks,
      how: `pause and escalate: present this phase and its choices to a human; a human records the decision with ` +
        `\`marionette state choose ${file} <choice> --actor <name> --rationale <text>\`. Do not take these choices autonomously. ` +
        (fallbacks.length === 0
          ? 'There is no implicit timeout or fallback; silence leaves the run parked.'
          : 'Only the graph-authored timeout fallback(s) listed in this payload may end the wait without a human decision.'),
    };
  }

  const visited = visitedPath(state).filter((id) => id !== END);

  return {
    spec: trajectory.spec,
    plan: {
      file,
      project: metaString(trajectory.meta['project']),
      hash: trajectory.hash,
      intent: {
        summary: metaText(trajectory.meta['summary']),
        prompt: metaText(trajectory.meta['prompt']),
      },
      refs: trajectory.refs,
    },
    status,
    variables: state.variables,
    pendingObservations: state.pendingObservations.map((name) => ({
      name,
      type: trajectory.variables[name]?.type ?? 'unknown',
    })),
    node: node
      ? {
          id: node.id,
          title: title(node)!,
          body: node.body,
          meta: node.meta,
          refs: node.refs,
          timebox: resolveTimebox(node.meta),
          priority: resolvePriority(node.meta),
          enteredAt: enteredAt(state, node.id),
        }
      : null,
    delivery: resolveDelivery(trajectory.meta, node?.meta ?? {}, node?.id ?? ''),
    frontier: choices,
    next,
    escalation,
    progress: {
      steps: state.log.length,
      nodesVisited: new Set(visited).size,
      nodesTotal: trajectory.nodes.length,
      path: visitedPath(state),
    },
    protocol: {
      choose: `marionette state choose ${file} <choice> --actor <name> --rationale <text>`,
      advance: `marionette state advance ${file} --actor <name> --rationale <text>`,
      observe: `marionette state observe ${file} <name> <json-value> --actor <name> --rationale <text>`,
      rules: [
        'do the work the current phase describes before recording an outcome',
        'supply only observations the brief requests, with the source in the rationale',
        'record every taken branch with an honest rationale (it is the audit trail)',
        'never take an @human choice as the agent: escalate and wait for a human decision',
        'gates are computed from the variables above: if a choice is blocked, it is not an option',
        're-run `marionette brief` after every recorded step: it is the single source of "what now"',
      ],
    },
  };
}

/** Render a millisecond span in the largest sensible single unit. */
function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Human-readable rendering of a brief (the `marionette brief` default). */
export function renderBrief(brief: Brief, style?: Style): string {
  const s = style ?? styleFor({ isTTY: false });
  const lines: string[] = [];
  const project = brief.plan.project ? ` — ${brief.plan.project}` : '';
  lines.push(s.bold(`work packet${project}`) + s.dim(` (${brief.plan.hash.slice(0, 19)}…)`));

  const badge =
    brief.status === 'completed' ? s.green('completed ✓')
    : brief.status === 'awaiting-observation' ? s.yellow('awaiting runtime observation ?')
    : brief.status === 'waiting-timeout' ? s.yellow('waiting for timeout')
    : brief.status === 'awaiting-human' ? s.magenta('awaiting human decision ✋')
    : brief.status === 'stranded' ? s.red('stranded — no available step')
    : s.cyan('active');
  lines.push(`status: ${badge}   progress: ${brief.progress.nodesVisited}/${brief.progress.nodesTotal} phases, ${brief.progress.steps} steps`);
  if (brief.plan.intent.summary) lines.push(`intent: ${brief.plan.intent.summary}`);
  if (brief.plan.intent.prompt) {
    lines.push(s.dim('prompt: ' + brief.plan.intent.prompt.split('\n').join('\n        ')));
  }

  if (brief.node) {
    lines.push('');
    lines.push(s.bold(`=== ${brief.node.id} ===`));
    lines.push(brief.node.body);
    if (brief.node.refs.length > 0) {
      lines.push('refs: ' + brief.node.refs.map((r) => r.url ?? `${r.provider}:${r.kind}:${r.id}`).join('  '));
    }
    const d = brief.delivery;
    lines.push(s.dim(`delivery: ${d.mode} · report ${d.report}${d.branch ? ` · branch ${d.branch}` : ''}`));
    // Legacy #timebox pacing remains consumer-side. Syntactic timeout edges
    // are evaluated separately by frontier() against the requested "now".
    if (brief.node.timebox || brief.node.priority) {
      const bits: string[] = [];
      if (brief.node.timebox) {
        const { source, seconds } = brief.node.timebox;
        if (brief.node.enteredAt) {
          const elapsed = Date.now() - Date.parse(brief.node.enteredAt);
          const overdue = elapsed > seconds * 1000;
          const note = `timebox ${source} — in phase ${spanText(elapsed)}`;
          bits.push(overdue ? s.red(note + ' (overdue: wrap up — take an exit honestly or escalate)') : note);
        } else {
          bits.push(`timebox ${source}`);
        }
      }
      if (brief.node.priority) bits.push(`priority ${brief.node.priority}`);
      lines.push(bits.join(' · '));
    }
  }

  const vars = Object.entries(brief.variables);
  if (vars.length > 0) {
    lines.push('variables: ' + vars.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', '));
  }
  if (brief.pendingObservations.length > 0) {
    lines.push('observations required: ' +
      brief.pendingObservations.map((item) => `${item.name}:${item.type}`).join(', '));
    lines.push(s.dim(`  supply with: ${brief.protocol.observe}`));
  }

  if (brief.frontier.length > 0) {
    lines.push('');
    lines.push('choices:');
    for (const c of brief.frontier) {
      const marks = [
        c.human ? s.magenta('@human') : null,
        c.loop ? s.cyan('~loop~') : null,
        c.gate ? s.dim(`{${c.gate}}`) : null,
        c.timeout ? s.yellow(`timeout ${c.timeout.source}`) : null,
      ].filter(Boolean).join(' ');
      const to = c.target === END ? 'END' : `${c.target}${c.targetTitle ? s.dim(` — ${c.targetTitle}`) : ''}`;
      const line = `  [${c.index}] ${c.label}${marks ? ' ' + marks : ''} -> ${to}`;
      lines.push(c.available ? line : s.dim(`${line}  [unavailable: ${c.blocked}]`));
    }
  }
  if (brief.next) {
    lines.push(s.dim(`  (automatic next step) -> ${brief.next.target} — marionette state advance`));
  }

  if (brief.escalation) {
    lines.push('');
    lines.push(s.magenta(s.bold('escalation required: ')) + brief.escalation.reason);
    for (const fallback of brief.escalation.fallbacks) {
      lines.push(s.yellow(
        `  authored fallback: ${fallback.label} (${fallback.choice})` +
        `${fallback.dueAt ? ` opens ${fallback.dueAt}` : ''}`,
      ));
    }
    lines.push('  ' + brief.escalation.how);
  }
  if (brief.status === 'stranded') {
    lines.push('');
    lines.push(s.red('this traversal is stuck: no choice or automatic next step is available.'));
    lines.push('  review the gates/variables above; the plan may need editing (then `marionette state rebind`).');
  }
  if (brief.status === 'completed') {
    lines.push('');
    lines.push(s.green('the plan has reached END — nothing left to execute.'));
  }
  return lines.join('\n') + '\n';
}
