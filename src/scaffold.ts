/**
 * `marionette import` — scaffold a .mar draft from tracker issues.
 *
 * The agent fetches issues with whatever tracker tools it has (marionette
 * holds no connection), shapes them into the provider-neutral JSON below, and
 * this module deterministically emits a compilable draft — so importing a
 * backlog costs the model a JSON list, not hand-written DSL:
 *
 *   {
 *     "tracker": "github",
 *     "context": "acme/platform",         // repo | jira site URL | linear workspace
 *     "project": "q3-backlog",            // optional # project: value
 *     "issues": [
 *       { "id": 12, "title": "Fix login redirect" },
 *       { "id": "14", "title": "Add SSO", "url": "https://…" }
 *     ]
 *   }
 *
 * Two shapes:
 *   --mode queue  (default) one work-queue phase with a bounded counter loop —
 *                 token cost stays O(1) in phase count however long the backlog
 *   --mode phases one linked phase per issue, chained in order
 */

import { TRACKERS, LINK_KEY, type TrackerProvider } from './sync.ts';

export interface ImportIssue {
  id: string | number;
  title: string;
  url?: string;
}

export interface ImportSpec {
  tracker: TrackerProvider;
  /** github "owner/repo" · jira site URL · linear workspace slug. */
  context?: string;
  /** Becomes `# project:`; defaults to "imported_backlog". */
  project?: string;
  issues: ImportIssue[];
}

export type ImportMode = 'queue' | 'phases';

export class ImportError extends Error {}

const CONTEXT_TAG: Record<TrackerProvider, string> = {
  github: 'github:repo',
  jira: 'jira:site',
  linear: 'linear:workspace',
};

/** Parse + validate the issues JSON an agent hands to `marionette import`. */
export function parseImportSpec(json: string): ImportSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ImportError('issues file is not valid JSON');
  }
  const spec = raw as ImportSpec;
  if (!spec || typeof spec !== 'object') throw new ImportError('issues file must be a JSON object');
  if (!(TRACKERS as readonly string[]).includes(spec.tracker)) {
    throw new ImportError(`"tracker" must be one of: ${TRACKERS.join(', ')}`);
  }
  if (!Array.isArray(spec.issues) || spec.issues.length === 0) {
    throw new ImportError('"issues" must be a non-empty array of { id, title }');
  }
  for (const [i, issue] of spec.issues.entries()) {
    if (issue === null || typeof issue !== 'object' ||
        (typeof issue.id !== 'string' && typeof issue.id !== 'number') ||
        typeof issue.title !== 'string' || issue.title.trim().length === 0) {
      throw new ImportError(`issues[${i}] must have an "id" and a non-empty "title"`);
    }
  }
  return spec;
}

/** Issue id as it appears in link metadata: bare number for github, KEY-1 upper-cased elsewhere. */
function metaId(provider: TrackerProvider, id: string | number): string {
  const raw = String(id).trim().replace(/^#/, '');
  return provider === 'github' ? raw : raw.toUpperCase();
}

/** Display form used in prose: #12 for github, PROJ-3 elsewhere. */
function displayId(provider: TrackerProvider, id: string | number): string {
  return provider === 'github' ? `#${metaId(provider, id)}` : metaId(provider, id);
}

/** One line of prose that can never be mistaken for a DSL construct. */
function proseTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? flat.slice(0, 99).trimEnd() + '…' : flat;
}

function phaseId(provider: TrackerProvider, id: string | number, used: Set<string>): string {
  const base = 'issue_' + metaId(provider, id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
  used.add(candidate);
  return candidate;
}

function preamble(spec: ImportSpec): string[] {
  const lines = [
    `// Imported from ${spec.tracker}${spec.context ? ` (${spec.context})` : ''} — ` +
      `${spec.issues.length} issue${spec.issues.length === 1 ? '' : 's'}, via \`marionette import\`.`,
    `# project: ${spec.project ?? 'imported_backlog'}`,
    `# tracker: ${spec.tracker}`,
  ];
  if (spec.context) lines.push(`# ${CONTEXT_TAG[spec.tracker]}: ${spec.context}`);
  return lines;
}

/** Emit a compilable .mar draft for the given issues. */
export function scaffoldPlan(spec: ImportSpec, mode: ImportMode = 'queue'): string {
  return (mode === 'queue' ? scaffoldQueue(spec) : scaffoldPhases(spec)).join('\n') + '\n';
}

function scaffoldQueue(spec: ImportSpec): string[] {
  const t = spec.tracker;
  return [
    ...preamble(spec),
    `VAR remaining = ${spec.issues.length}`,
    '',
    '=== work_queue ===',
    'Work the backlog one issue at a time: pick the next open item below, do the',
    'work it describes, and record the outcome with an honest rationale.',
    ...spec.issues.map((i) => `- ${displayId(t, i.id)} ${proseTitle(i.title)}`),
    `# ${LINK_KEY[t]}: ${spec.issues.map((i) => metaId(t, i.id)).join(', ')}`,
    '~ remaining -= 1',
    '+ {remaining > 0} [Issue done, more remain] ~loop~ -> work_queue',
    '* {remaining <= 0} [Backlog clear] -> END',
  ];
}

function scaffoldPhases(spec: ImportSpec): string[] {
  const t = spec.tracker;
  const used = new Set<string>();
  const ids = spec.issues.map((i) => phaseId(t, i.id, used));
  const lines = preamble(spec);
  for (const [idx, issue] of spec.issues.entries()) {
    const next = idx + 1 < ids.length ? ids[idx + 1] : 'END';
    lines.push(
      '',
      `=== ${ids[idx]} ===`,
      `Issue ${displayId(t, issue.id)}: ${proseTitle(issue.title)}`,
      `# ${LINK_KEY[t]}: ${metaId(t, issue.id)}`,
      `* [Done] -> ${next}`,
      `* [Blocked or deferred, move on] -> ${next}`,
    );
  }
  return lines;
}
