/**
 * Tracker sync (Phase 2, PRD P2 integrations — promoted from the parking lot).
 *
 * Marionette never talks to Jira/Linear/GitHub itself. It computes a
 * deterministic, provider-neutral **sync manifest** — what an executor holding
 * tracker tools (an MCP server, a CLI, a skill) should create, comment or
 * close — and provides the mechanical write-back commands that record the
 * results in the plan source. The agent's own capabilities carry the API
 * calls; the plan and its sidecar carry the durable cross-references.
 *
 *   marionette sync <plan> --json      → the manifest (both directions of truth)
 *   marionette sync bind <plan> --tracker github    → remember the tracker in the preamble
 *   marionette sync link <plan> <node> <id>         → write a created issue id into the phase
 *   marionette sync mark <plan> [--cursor N]        → advance the audit cursor
 *
 * The audit stream is the decision log: entries past the sidecar's cursor
 * become `comment` ops, so the tracker mirrors the rationale trail without
 * marionette owning a connection.
 */

import type { Ref, Trajectory, PlanState } from './types.js';
import { CODES } from './types.js';
import type { Style } from './term.js';
import { styleFor } from './term.js';

/** Well-known trackers a plan can bind to (`# tracker:`). Open set elsewhere; these get URL/context support. */
export const TRACKERS = ['github', 'jira', 'linear'] as const;
export type TrackerProvider = (typeof TRACKERS)[number];

/** The plan-meta key that supplies each tracker's URL context. */
const CONTEXT_KEY: Record<TrackerProvider, string> = {
  github: 'github:repo',
  jira: 'jira:site',
  linear: 'linear:workspace',
};

/** The node-meta key `sync link` writes an issue id under. */
export const LINK_KEY: Record<TrackerProvider, string> = {
  github: 'github:issue',
  jira: 'jira',
  linear: 'linear',
};

export interface TrackerBinding {
  provider: TrackerProvider;
  /** `explicit` = `# tracker:` tag; `inferred` = exactly one provider context present. */
  source: 'explicit' | 'inferred';
  /** The provider's URL context (repo, site, workspace) when present. */
  context: string | null;
}

export interface TrackerResolution {
  binding: TrackerBinding | null;
  /** Providers with any presence in the plan (context meta or refs) when unbound. */
  candidates: TrackerProvider[];
  /** What an executor should do about a missing binding (null when bound). */
  needs: string | null;
}

const metaLast = (meta: Record<string, string | string[]>, key: string): string | null => {
  const v = meta[key];
  if (v === undefined) return null;
  return Array.isArray(v) ? v[v.length - 1] : v;
};

/**
 * Resolve which tracker this plan is bound to. Explicit `# tracker:` wins;
 * otherwise exactly one provider with presence (context meta or refs) is
 * inferred; anything else is ambiguous and the executor must ask a human
 * once, then record the answer with `marionette sync bind`.
 */
export function resolveTracker(trajectory: Trajectory): TrackerResolution {
  const explicit = metaLast(trajectory.meta, 'tracker');
  const context = (p: TrackerProvider) => metaLast(trajectory.meta, CONTEXT_KEY[p]);

  if (explicit !== null) {
    const provider = explicit.toLowerCase() as TrackerProvider;
    if ((TRACKERS as readonly string[]).includes(provider)) {
      return { binding: { provider, source: 'explicit', context: context(provider) }, candidates: [], needs: null };
    }
    // Unknown value: fall through to inference; validate() warns MAR020.
  }

  const present = new Set<TrackerProvider>();
  for (const p of TRACKERS) if (context(p) !== null) present.add(p);
  for (const ref of [...trajectory.refs, ...trajectory.nodes.flatMap((n) => n.refs)]) {
    if ((TRACKERS as readonly string[]).includes(ref.provider)) present.add(ref.provider as TrackerProvider);
  }
  const candidates = [...present];
  if (candidates.length === 1) {
    const provider = candidates[0];
    return { binding: { provider, source: 'inferred', context: context(provider) }, candidates, needs: null };
  }
  const which = candidates.length === 0
    ? `no tracker context found in the plan`
    : `ambiguous tracker: the plan references ${candidates.join(' and ')}`;
  return {
    binding: null,
    candidates,
    needs: `${which}. Ask the plan owner which tracker to bind, then record it: ` +
      `marionette sync bind <plan> --tracker <${TRACKERS.join('|')}>`,
  };
}

/** Warn (MAR020) when an explicit `# tracker:` value is not a known tracker. */
export function validateTracker(
  planMeta: Record<string, string | string[]>,
  warn: (code: string, message: string, suggestion?: string) => void,
): void {
  const value = metaLast(planMeta, 'tracker');
  if (value !== null && !(TRACKERS as readonly string[]).includes(value.toLowerCase())) {
    warn(CODES.UNKNOWN_TRACKER, `unknown tracker "${value}"`,
      `expected one of: ${TRACKERS.join(', ')}`);
  }
}

/**
 * Warn (MAR020) when `# tracker:` appears on a node: the binding is
 * plan-level only (one tracker per plan) and a node-level tag has no effect —
 * unlike delivery/report, which node tags legitimately override.
 */
export function validateNodeTracker(
  nodeMeta: Record<string, string | string[]>,
  warn: (code: string, message: string, suggestion?: string) => void,
): void {
  if (metaLast(nodeMeta, 'tracker') !== null) {
    warn(CODES.UNKNOWN_TRACKER, '"tracker" is plan-level metadata; this node-level tag has no effect',
      'move "# tracker:" to the preamble (before the first phase header)');
  }
}

/** One tracker-shaped action for the executor to apply with its own tools. */
export interface SyncOp {
  op: 'ensure-issue' | 'comment' | 'close';
  /** The plan phase this op belongs to. */
  node: string;
  /** The already-linked ref for comment/close ops; null for ensure-issue. */
  ref: Ref | null;
  /** Issue title (ensure-issue only). */
  title?: string;
  /** Issue body / comment body / closing note. */
  body: string;
  /**
   * Stable dedupe key. Embed it in what you post (e.g. a trailing marker
   * line) and skip ops whose key is already present on the tracker item.
   */
  idempotencyKey: string;
  /** ensure-issue only: the command that records the created id in the plan. */
  writeback?: string;
}

export interface SyncManifest {
  spec: string;
  plan: { file: string; project: string | null; hash: string };
  tracker: TrackerBinding | null;
  candidates: TrackerProvider[];
  /** Present when tracker is null: how to resolve the binding. */
  needs: string | null;
  /** Decision-log window covered by the comment ops: [from, to). */
  cursor: { from: number; to: number };
  ops: SyncOp[];
  /** Standing instructions for whichever agent applies the manifest. */
  apply: string[];
}

const issueRefs = (refs: Ref[], provider: TrackerProvider): Ref[] =>
  refs.filter((r) => r.provider === provider && r.kind === 'issue');

const hashKey = (hash: string): string => hash.replace(/^sha256:/, '').slice(0, 12);

const nodeTitle = (body: string, id: string): string => body.split('\n')[0] || id;

/**
 * Compute the sync manifest: ensure ops for unlinked phases, comment ops for
 * decision-log entries past `cursor`, close ops for linked phases once the
 * plan completes. Pure and deterministic — no I/O, no clock.
 */
export function buildSyncManifest(
  trajectory: Trajectory,
  state: PlanState | null,
  options: { file: string; cursor?: number },
): SyncManifest {
  const { binding, candidates, needs } = resolveTracker(trajectory);
  const key = hashKey(trajectory.hash);
  const file = options.file;
  const from = Math.min(options.cursor ?? 0, state?.log.length ?? 0);
  const to = state?.log.length ?? 0;
  const ops: SyncOp[] = [];

  if (binding) {
    for (const node of trajectory.nodes) {
      const linked = issueRefs(node.refs, binding.provider);
      if (linked.length === 0) {
        const exits = [
          ...node.choices.map((c) => {
            const marks = [c.human ? '@human' : null, c.gate ? `{${c.gate.source}}` : null]
              .filter(Boolean).join(' ');
            return `- [${c.label}]${marks ? ' ' + marks : ''} → ${c.target}`;
          }),
          ...(node.divert ? [`- (fallthrough) → ${node.divert.target}`] : []),
        ];
        ops.push({
          op: 'ensure-issue',
          node: node.id,
          ref: null,
          title: nodeTitle(node.body, node.id),
          body: node.body +
            (exits.length > 0 ? `\n\nExits:\n${exits.join('\n')}` : '') +
            `\n\nManaged by Marionette — plan \`${file}\`, phase \`${node.id}\`.`,
          idempotencyKey: `${key}:ensure:${node.id}`,
          writeback: `marionette sync link ${file} ${node.id} <created-issue-id>`,
        });
      }
    }

    if (state) {
      for (let idx = from; idx < to; idx++) {
        const entry = state.log[idx];
        if (entry.from === null) continue; // plan start — no phase was exited
        const fromNode = trajectory.nodes.find((n) => n.id === entry.from);
        if (!fromNode) continue;
        const refs = issueRefs(fromNode.refs, binding.provider);
        if (refs.length === 0) continue; // unlinked phase: nowhere to comment
        ops.push({
          op: 'comment',
          node: fromNode.id,
          ref: refs[0],
          body: `**${entry.label ?? 'fallthrough'}** → \`${entry.to}\`\n` +
            `${entry.rationale ?? '(no rationale recorded)'} — ${entry.actor}, ${entry.at}`,
          idempotencyKey: `${key}:log:${idx}`,
        });
      }

      if (state.status === 'completed') {
        const visited = new Set(state.log.map((e) => e.to));
        for (const node of trajectory.nodes) {
          if (!visited.has(node.id)) continue;
          for (const ref of issueRefs(node.refs, binding.provider)) {
            ops.push({
              op: 'close',
              node: node.id,
              ref,
              body: `Plan \`${file}\` completed — closing the issue tracking phase \`${node.id}\`.`,
              idempotencyKey: `${key}:close:${node.id}:${ref.id}`,
            });
          }
        }
      }
    }
  }

  return {
    spec: '0.1.0',
    plan: {
      file,
      project: metaLast(trajectory.meta, 'project'),
      hash: trajectory.hash,
    },
    tracker: binding,
    candidates,
    needs,
    cursor: { from, to },
    ops,
    apply: [
      'apply these ops with the tracker tools available in your context (MCP server, CLI, skill); marionette holds no tracker connection',
      'if no tool for this tracker is available, report that to the user — do not fabricate a sync',
      'embed each op\'s idempotencyKey in what you post (e.g. a trailing marker line) and skip ops whose key already appears on the item',
      'when a phase links several issues (a work queue), attach each comment to the issue its rationale addresses; the op\'s ref is only the default',
      'after an ensure-issue is created, record the id with the op\'s writeback command (it updates the plan and rebinds state)',
      `after applying, advance the audit cursor: marionette sync mark ${file}`,
    ],
  };
}

// ── Sidecar: <plan>.sync.json ────────────────────────────────────────────────

/** Sync sidecar: the applied-through cursor over the decision log. Commit it with the plan. */
export interface SyncSidecar {
  spec: string;
  /** Decision-log entries [0, cursor) have been mirrored to the tracker. */
  cursor: number;
  /** Trajectory hash when the cursor was last advanced (informational; the log survives rebind). */
  hash: string;
  updated: string;
}

export function syncFileFor(planFile: string): string {
  return planFile.replace(/\.(mar|trajectory\.json|json)$/, '') + '.sync.json';
}

// ── Mechanical .mar edits (bind / link) ──────────────────────────────────────

export class SyncEditError extends Error {}

const HEADER = /^={2,}\s*([^=\s]+)\s*=*$/;

/**
 * Mark every line that belongs to a fenced metadata value (`# key: """` …
 * `"""`), opening and closing lines included. Fenced content is verbatim
 * markdown — a line inside may look exactly like a phase header or a tag,
 * so every scan and insertion below must skip these lines.
 */
function fencedLines(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (open) {
      mask[i] = true;
      if (t === '"""') open = false;
    } else if (/^#\s*.+?:\s+"""\s*$/.test(t)) {
      mask[i] = true;
      open = true;
    }
  }
  return mask;
}

/**
 * Insert or replace `# tracker: <provider>` in the preamble. Pure text
 * transform; the caller recompiles, writes, and rebinds state.
 */
export function bindTrackerInSource(source: string, provider: TrackerProvider): string {
  const lines = source.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const headerIdx = lines.findIndex((l, i) => !fenced[i] && HEADER.test(l.trim()));
  const preambleEnd = headerIdx === -1 ? lines.length : headerIdx;

  for (let i = 0; i < preambleEnd; i++) {
    if (!fenced[i] && /^#\s*tracker\s*:/.test(lines[i].trim())) {
      lines[i] = `# tracker: ${provider}`;
      return lines.join('\n');
    }
  }

  // After the last preamble tag (or fenced block) if there is one, else after
  // the leading comment block, so the tag sits with its peers.
  let insertAt = 0;
  while (insertAt < preambleEnd && lines[insertAt].trim().startsWith('//')) insertAt++;
  for (let i = 0; i < preambleEnd; i++) {
    if (fenced[i] || lines[i].trim().startsWith('#')) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `# tracker: ${provider}`);
  return lines.join('\n');
}

const GITHUB_LINK_ID = /^(?:[\w.-]+\/[\w.-]+#)?#?\d+$/;
const TRACKER_LINK_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Insert a tracker issue reference into a phase's metadata, directly under
 * its header line. Pure text transform; caller recompiles + rebinds.
 */
export function linkNodeInSource(
  source: string,
  nodeId: string,
  provider: TrackerProvider,
  id: string,
): string {
  const cleaned = id.trim().replace(/^#/, '');
  if (provider === 'github' ? !GITHUB_LINK_ID.test(cleaned) : !TRACKER_LINK_ID.test(cleaned)) {
    throw new SyncEditError(provider === 'github'
      ? `"${id}" is not a github issue reference (expected "12" or "owner/name#12")`
      : `"${id}" is not a ${provider} issue key (expected e.g. "PROJ-123")`);
  }
  const value = provider === 'github' ? cleaned : cleaned.toUpperCase();

  const lines = source.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const headerIdx = lines.findIndex((l, i) => {
    if (fenced[i]) return false;
    const m = l.trim().match(HEADER);
    return m !== null && m[1] === nodeId;
  });
  if (headerIdx === -1) {
    throw new SyncEditError(`phase "${nodeId}" not found in the plan source`);
  }
  lines.splice(headerIdx + 1, 0, `# ${LINK_KEY[provider]}: ${value}`);
  return lines.join('\n');
}

// ── Human rendering ──────────────────────────────────────────────────────────

export function renderSyncManifest(manifest: SyncManifest, style?: Style): string {
  const s = style ?? styleFor({ isTTY: false });
  const lines: string[] = [];
  const project = manifest.plan.project ? ` — ${manifest.plan.project}` : '';
  lines.push(s.bold(`tracker sync${project}`) + s.dim(` (${manifest.plan.hash.slice(0, 19)}…)`));

  if (manifest.tracker) {
    const ctx = manifest.tracker.context ? ` · ${manifest.tracker.context}` : '';
    lines.push(`tracker: ${s.cyan(manifest.tracker.provider)}${ctx} ${s.dim(`(${manifest.tracker.source})`)}`);
  } else {
    lines.push(s.yellow('tracker: unbound — no sync ops can be computed'));
    if (manifest.needs) lines.push('  ' + manifest.needs);
    return lines.join('\n') + '\n';
  }
  lines.push(`audit cursor: ${manifest.cursor.from} → ${manifest.cursor.to} of the decision log`);

  if (manifest.ops.length === 0) {
    lines.push(s.green('nothing to sync — every phase is linked and the audit trail is mirrored.'));
  } else {
    const counts = ['ensure-issue', 'comment', 'close']
      .map((k) => [k, manifest.ops.filter((o) => o.op === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    lines.push('');
    lines.push(s.bold(`${manifest.ops.length} op${manifest.ops.length === 1 ? '' : 's'}`) + s.dim(` (${counts})`));
    for (const op of manifest.ops) {
      const where = op.ref ? (op.ref.url ?? op.ref.id) : op.title;
      lines.push(`  ${op.op.padEnd(12)} ${s.bold(op.node)}  ${s.dim(where ?? '')}`);
    }
    lines.push('');
    lines.push(s.dim('apply with your own tracker tools, then: marionette sync mark ' + manifest.plan.file));
    lines.push(s.dim('machine form: marionette sync ' + manifest.plan.file + ' --json'));
  }
  return lines.join('\n') + '\n';
}
