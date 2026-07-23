/**
 * Compile a .mar script into a trajectory document (the contract, P0.1),
 * running structural validation and gate checking along the way.
 */

import { createHash } from 'node:crypto';
import type { Diagnostic, Trajectory } from './types.js';
import { SPEC_VERSION } from './types.js';
import { parsePlan } from './parser.js';
import { validatePlan } from './validate.js';

export interface CompileResult {
  /** Present whenever the plan parsed far enough to build a graph (even with errors). */
  trajectory: Trajectory | null;
  diagnostics: Diagnostic[];
  /** True iff there are no error-severity diagnostics. */
  ok: boolean;
}

export interface CompileOptions {
  /** Recorded in the trajectory's `source.file` (not part of the hash). */
  file?: string;
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const parsed = parsePlan(source);
  const diagnostics = [...parsed.diagnostics];
  validatePlan(parsed, diagnostics);

  const ok = !diagnostics.some((d) => d.severity === 'error');
  if (parsed.nodes.length === 0 || parsed.start === null) {
    return { trajectory: null, diagnostics, ok: false };
  }

  const trajectory: Trajectory = {
    spec: SPEC_VERSION,
    hash: '',
    source: { file: options.file ?? '<memory>' },
    variables: parsed.variables,
    start: parsed.start,
    nodes: parsed.nodes,
    meta: parsed.meta,
  };
  trajectory.hash = trajectoryHash(trajectory);
  return { trajectory, diagnostics, ok };
}

/**
 * Content hash over the semantic graph: canonical JSON (sorted keys, no
 * whitespace) with `hash`, `source` and all `line` fields excluded — so
 * comments/whitespace/file moves don't invalidate recorded state, but any
 * change to variables, nodes, gates, choices or metadata does.
 */
export function trajectoryHash(trajectory: Trajectory): string {
  const { hash: _hash, source: _source, ...rest } = trajectory;
  const canonical = canonicalize(rest);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k, v]) => k !== 'line' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v));
  return '{' + entries.join(',') + '}';
}

/** Render diagnostics in a compiler-style, line-numbered format. */
export function formatDiagnostics(diagnostics: Diagnostic[], file = 'plan.mar'): string {
  const lines: string[] = [];
  for (const d of diagnostics) {
    const loc = d.line !== undefined ? `${file}:${d.line}` : file;
    lines.push(`${loc}: ${d.severity}[${d.code}]: ${d.message}`);
    if (d.suggestion) lines.push(`  help: ${d.suggestion}`);
  }
  return lines.join('\n');
}
