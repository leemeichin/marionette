/**
 * External references and delivery config (Phase 2 ingestion metadata).
 *
 * The DSL's namespaced `# key: value` tags are the extension mechanism; this
 * module gives the well-known namespaces a normalised, structured form so that
 * executors (pi agent, Claude sessions, CI) never re-parse meta conventions:
 *
 *   # github:repo: acme/platform          context + a "repo" ref
 *   # github:issue: 12                    → https://github.com/acme/platform/issues/12
 *   # github:pr: 7, 9                     comma-separated lists allowed
 *   # jira: PROJ-123                      with plan-level  # jira:site: https://…
 *   # linear: ENG-42                      with plan-level  # linear:workspace: acme
 *   # ref: https://wiki.acme.dev/brief    generic link
 *
 * Delivery config — how an executor portions out and reports the work:
 *
 *   # delivery: pr-per-phase | branch-per-phase | single-pr | single-branch | none
 *   # delivery:branch: replatform/{phase}    branch name template ({phase} → node id)
 *   # report: per-phase | at-checkpoints | at-end
 *
 * Plan-level tags set the default; node-level tags override per phase.
 */

import type { Diagnostic, Ref } from './types.js';
import { CODES } from './types.js';
import { validateNodeTracker, validateTracker } from './sync.js';

type Meta = Record<string, string | string[]>;

export const DELIVERY_MODES = [
  /** Each phase's work lands as its own pull request. */
  'pr-per-phase',
  /** A branch per phase; pull requests at the executor's discretion. */
  'branch-per-phase',
  /** One pull request for the whole traversal. */
  'single-pr',
  /** One branch, commits per phase, no PR automation. */
  'single-branch',
  /** No prescribed packaging (non-code plans, or executor's discretion). */
  'none',
] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const REPORT_CADENCES = [
  /** Report back to the primary session after every phase. */
  'per-phase',
  /** Report only at @human checkpoints and completion. */
  'at-checkpoints',
  /** Report once, when the traversal completes (or strands). */
  'at-end',
] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

/** How an executor should portion out and report the work of a phase. */
export interface DeliveryConfig {
  mode: DeliveryMode;
  report: ReportCadence;
  /** Branch name (template `{phase}` already expanded), or null when unset. */
  branch: string | null;
}

export const DEFAULT_DELIVERY: DeliveryConfig = { mode: 'none', report: 'per-phase', branch: null };

/** Context needed to synthesise browsable URLs, from plan+node meta. */
interface RefContext {
  repo: string | null;
  jiraSite: string | null;
  linearWorkspace: string | null;
}

type Warn = (code: string, message: string, suggestion?: string) => void;

const values = (meta: Meta, key: string): string[] => {
  const v = meta[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
};

const last = (meta: Meta, key: string): string | null => {
  const all = values(meta, key);
  return all.length > 0 ? all[all.length - 1] : null;
};

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_ITEM = /^(?:([\w.-]+\/[\w.-]+)#)?#?(\d+)$/;
const TRACKER_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function refContext(planMeta: Meta, nodeMeta: Meta): RefContext {
  return {
    repo: last(nodeMeta, 'github:repo') ?? last(planMeta, 'github:repo'),
    jiraSite: (last(nodeMeta, 'jira:site') ?? last(planMeta, 'jira:site'))?.replace(/\/+$/, '') ?? null,
    linearWorkspace: last(nodeMeta, 'linear:workspace') ?? last(planMeta, 'linear:workspace'),
  };
}

/**
 * Normalise the well-known ref namespaces of one meta block into structured
 * refs. `planMeta` supplies fallback context (repo, site, workspace); pass the
 * same object twice for plan-level extraction.
 */
export function extractRefs(meta: Meta, planMeta: Meta, warn: Warn = () => {}): Ref[] {
  const ctx = refContext(planMeta, meta);
  const refs: Ref[] = [];

  for (const repo of values(meta, 'github:repo')) {
    if (!GITHUB_REPO.test(repo)) {
      warn(CODES.MALFORMED_REF, `malformed github:repo "${repo}"`, 'expected "owner/name"');
      continue;
    }
    refs.push({ provider: 'github', kind: 'repo', id: repo, url: `https://github.com/${repo}` });
  }

  for (const kind of ['issue', 'pr'] as const) {
    for (const value of values(meta, `github:${kind}`)) {
      for (const item of value.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = item.match(GITHUB_ITEM);
        if (!m) {
          warn(CODES.MALFORMED_REF, `malformed github:${kind} "${item}"`,
            'expected an issue/PR number ("12") or "owner/name#12"');
          continue;
        }
        const repo = m[1] ?? ctx.repo;
        const path = kind === 'issue' ? 'issues' : 'pull';
        refs.push({
          provider: 'github',
          kind,
          id: repo ? `${repo}#${m[2]}` : `#${m[2]}`,
          url: repo ? `https://github.com/${repo}/${path}/${m[2]}` : null,
        });
      }
    }
  }

  for (const value of values(meta, 'jira')) {
    for (const key of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!TRACKER_KEY.test(key)) {
        warn(CODES.MALFORMED_REF, `malformed jira key "${key}"`, 'expected e.g. "PROJ-123"');
        continue;
      }
      refs.push({
        provider: 'jira',
        kind: 'issue',
        id: key.toUpperCase(),
        url: ctx.jiraSite ? `${ctx.jiraSite}/browse/${key.toUpperCase()}` : null,
      });
    }
  }

  for (const value of values(meta, 'linear')) {
    for (const key of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!TRACKER_KEY.test(key)) {
        warn(CODES.MALFORMED_REF, `malformed linear id "${key}"`, 'expected e.g. "ENG-42"');
        continue;
      }
      refs.push({
        provider: 'linear',
        kind: 'issue',
        id: key.toUpperCase(),
        url: ctx.linearWorkspace ? `https://linear.app/${ctx.linearWorkspace}/issue/${key.toUpperCase()}` : null,
      });
    }
  }

  for (const url of values(meta, 'ref')) {
    if (!/^https?:\/\/\S+$/.test(url)) {
      warn(CODES.MALFORMED_REF, `malformed ref "${url}"`, 'expected an http(s) URL');
      continue;
    }
    refs.push({ provider: 'url', kind: 'link', id: url, url });
  }

  return refs;
}

/** Validate delivery/report tags of one meta block (enum membership). */
export function validateDelivery(meta: Meta, warn: Warn): void {
  const mode = last(meta, 'delivery');
  if (mode !== null && !(DELIVERY_MODES as readonly string[]).includes(mode)) {
    warn(CODES.UNKNOWN_DELIVERY, `unknown delivery mode "${mode}"`,
      `expected one of: ${DELIVERY_MODES.join(', ')}`);
  }
  const report = last(meta, 'report');
  if (report !== null && !(REPORT_CADENCES as readonly string[]).includes(report)) {
    warn(CODES.UNKNOWN_DELIVERY, `unknown report cadence "${report}"`,
      `expected one of: ${REPORT_CADENCES.join(', ')}`);
  }
}

/**
 * Resolve the delivery config effective at one node: node tags override plan
 * tags; unknown values fall back to the defaults; `{phase}` in the branch
 * template expands to the node id.
 */
export function resolveDelivery(planMeta: Meta, nodeMeta: Meta, nodeId: string): DeliveryConfig {
  const pick = (key: string): string | null => last(nodeMeta, key) ?? last(planMeta, key);
  const mode = pick('delivery');
  const report = pick('report');
  const branch = pick('delivery:branch');
  return {
    mode: (DELIVERY_MODES as readonly string[]).includes(mode ?? '') ? (mode as DeliveryMode) : DEFAULT_DELIVERY.mode,
    report: (REPORT_CADENCES as readonly string[]).includes(report ?? '') ? (report as ReportCadence) : DEFAULT_DELIVERY.report,
    branch: branch ? branch.replaceAll('{phase}', nodeId) : null,
  };
}

/* ---- Pacing: timeboxes and priority (time as evidence, never as a gate) ----
 *
 *   # timebox: 3d        advisory wall-clock budget for a speculative phase
 *   # priority: high     executor ordering hint; maps to tracker priority on sync
 *
 * The walker never consults the clock — determinism, replay and static gate
 * verification depend on that. A timebox is carried in the brief alongside
 * the phase's entry timestamp; the executor treats "overdue" as evidence for
 * the phase's abandon exit, and the decision log records that time drove it.
 */

export const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A parsed `# timebox:` value: original spelling plus normalised seconds. */
export interface Timebox {
  source: string;
  seconds: number;
}

const TIMEBOX_UNITS: Record<string, number> = { m: 60, h: 3600, d: 86400, w: 604800 };

/** Parse a single-unit duration ("30m", "4h", "3d", "2w"), or null. */
export function parseTimebox(value: string): Timebox | null {
  const m = value.trim().match(/^(\d+)([mhdw])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 0) return null;
  return { source: value.trim(), seconds: n * TIMEBOX_UNITS[m[2]] };
}

/** Validate node-level pacing tags (MAR021/MAR022). */
export function validatePacing(meta: Meta, warn: Warn): void {
  const timebox = last(meta, 'timebox');
  if (timebox !== null && parseTimebox(timebox) === null) {
    warn(CODES.MALFORMED_TIMEBOX, `malformed timebox "${timebox}"`,
      'expected <n><unit> with unit m|h|d|w, e.g. "90m", "4h", "3d", "2w"');
  }
  const priority = last(meta, 'priority');
  if (priority !== null && !(PRIORITIES as readonly string[]).includes(priority)) {
    warn(CODES.UNKNOWN_PRIORITY, `unknown priority "${priority}"`,
      `expected one of: ${PRIORITIES.join(', ')}`);
  }
}

export function resolveTimebox(nodeMeta: Meta): Timebox | null {
  const timebox = last(nodeMeta, 'timebox');
  return timebox === null ? null : parseTimebox(timebox);
}

export function resolvePriority(nodeMeta: Meta): Priority | null {
  const priority = last(nodeMeta, 'priority');
  return priority !== null && (PRIORITIES as readonly string[]).includes(priority)
    ? (priority as Priority)
    : null;
}

/** Attach refs to a parsed plan's nodes + plan meta, emitting MAR018/MAR019 warnings. */
export function analyzeMeta(
  planMeta: Meta,
  nodes: { id: string; line: number; meta: Meta; refs: Ref[] }[],
  diagnostics: Diagnostic[],
): Ref[] {
  const warnAt = (line: number | undefined): Warn =>
    (code, message, suggestion) => diagnostics.push({ severity: 'warning', code, message, line, suggestion });

  const planRefs = extractRefs(planMeta, planMeta, warnAt(undefined));
  validateDelivery(planMeta, warnAt(undefined));
  validateTracker(planMeta, warnAt(undefined));
  for (const node of nodes) {
    node.refs = extractRefs(node.meta, planMeta, warnAt(node.line));
    validateDelivery(node.meta, warnAt(node.line));
    validateNodeTracker(node.meta, warnAt(node.line));
    validatePacing(node.meta, warnAt(node.line));
  }
  return planRefs;
}
