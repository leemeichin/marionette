/**
 * marionette CLI (P0.8): compile | validate | render | summarize | state.
 *
 * Exit codes (CI-suitable):
 *   0  success (warnings allowed unless --strict)
 *   1  validation errors (or warnings with --strict), refused walk operations
 *   2  usage or I/O errors
 *   3  plan/state drift detected
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Diagnostic, PlanState, Trajectory } from './types.js';
import { compile, formatDiagnostics } from './compile.js';
import { renderMermaid } from './render.js';
import { summarize } from './summarize.js';
import {
  DriftError, WalkError, advance, bindState, frontier, initState, parseState,
  serializeState, takeChoice,
} from './state.js';

const USAGE = `marionette — compiled project trajectories for AI agents

Usage:
  marionette compile   <plan.mar> [-o out.trajectory.json]   Compile to trajectory JSON
  marionette validate  <plan.mar> [--strict]                 Check only; print diagnostics
  marionette render    <plan.mar|.json> [--state f] [-o out.mmd] [--lr]
  marionette summarize <plan.mar|.json> [--state f] [-o out.md]
  marionette state init    <plan.mar|.json> [--state f] [--force]
  marionette state show    <plan.mar|.json> [--state f]
  marionette state choose  <plan.mar|.json> <choice> --actor <name> --rationale <text> [--state f]
  marionette state advance <plan.mar|.json> --actor <name> [--rationale <text>] [--state f]

Options:
  -o, --out <file>    Output file ('-' for stdout; default varies by command)
  --state <file>      State file (default: <plan>.state.json)
  --strict            Treat warnings as errors (exit 1)
  --lr                Render left-to-right instead of top-down
  --force             Overwrite an existing state file on init
  --actor <name>      Who takes the step ("agent" may not pass @human gates)
  --rationale <text>  Why the step was taken (required for choices)
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const takesValue = new Set(['-o', '--out', '--state', '--actor', '--rationale']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('-') && arg !== '-') {
      if (takesValue.has(arg)) {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`missing value for ${arg}`);
        flags[arg.replace(/^-+/, '')] = value;
      } else {
        flags[arg.replace(/^-+/, '')] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  if (flags['o'] !== undefined) flags['out'] = flags['o'];
  return { positional, flags };
}

class UsageError extends Error {}

function readSource(file: string): { trajectory: Trajectory; diagnostics: Diagnostic[]; ok: boolean } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
  }
  if (file.endsWith('.json')) {
    const trajectory = JSON.parse(text) as Trajectory;
    if (!trajectory.hash || !trajectory.nodes) throw new UsageError(`${file} is not a trajectory document`);
    return { trajectory, diagnostics: [], ok: true };
  }
  const result = compile(text, { file });
  if (!result.trajectory) {
    process.stderr.write(formatDiagnostics(result.diagnostics, file) + '\n');
    throw new UsageError(`${file} did not compile`);
  }
  return { trajectory: result.trajectory, diagnostics: result.diagnostics, ok: result.ok };
}

function output(flags: Args['flags'], fallback: string | null, content: string): void {
  const out = (flags['out'] as string | undefined) ?? fallback;
  if (out === null || out === '-' || out === undefined) {
    process.stdout.write(content);
  } else {
    writeFileSync(out, content);
    process.stderr.write(`wrote ${out}\n`);
  }
}

function stateFileFor(planFile: string, flags: Args['flags']): string {
  if (typeof flags['state'] === 'string') return flags['state'];
  return planFile.replace(/\.(mar|trajectory\.json|json)$/, '') + '.state.json';
}

function loadState(trajectory: Trajectory, file: string): PlanState {
  if (!existsSync(file)) {
    throw new UsageError(`no state file at ${file}; run "marionette state init" first`);
  }
  const state = parseState(readFileSync(file, 'utf8'));
  bindState(trajectory, state);
  return state;
}

function printFrontier(trajectory: Trajectory, state: PlanState): void {
  const node = trajectory.nodes.find((n) => n.id === state.current);
  process.stdout.write(`current: ${state.current}${state.status === 'completed' ? ' (completed)' : ''}\n`);
  if (node?.body) process.stdout.write(node.body + '\n');
  const vars = Object.entries(state.variables);
  if (vars.length > 0) {
    process.stdout.write('variables: ' + vars.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') + '\n');
  }
  if (state.status === 'completed') return;
  const options = frontier(trajectory, state);
  if (options.length === 0) {
    if (node?.divert) process.stdout.write(`no choices; divert available -> ${node.divert.target} (marionette state advance)\n`);
    return;
  }
  process.stdout.write('choices:\n');
  for (let i = 0; i < options.length; i++) {
    const { choice, blocked } = options[i];
    const marks = [choice.human ? '@human' : null, choice.loop ? '~loop~' : null,
      choice.gate ? `{${choice.gate.source}}` : null].filter(Boolean).join(' ');
    const status = blocked ? `  [unavailable: ${blocked}]` : '';
    process.stdout.write(`  [${i}] ${choice.label}${marks ? ' ' + marks : ''} -> ${choice.target}${status}\n`);
  }
  if (node?.divert) process.stdout.write(`  (fallthrough) -> ${node.divert.target}\n`);
}

export function run(argv: string[]): number {
  try {
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    }
    if (command === 'version' || command === '--version') {
      process.stdout.write('marionette 0.1.0\n');
      return 0;
    }

    switch (command) {
      case 'compile': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('compile: missing <plan.mar>');
        const text = readFileSync(file, 'utf8');
        const result = compile(text, { file });
        if (result.diagnostics.length > 0) {
          process.stderr.write(formatDiagnostics(result.diagnostics, file) + '\n');
        }
        if (!result.ok || !result.trajectory) return 1;
        if (flags['strict'] && result.diagnostics.length > 0) return 1;
        const fallback = file.replace(/\.mar$/, '') + '.trajectory.json';
        output(flags, fallback, JSON.stringify(result.trajectory, null, 2) + '\n');
        return 0;
      }

      case 'validate': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('validate: missing <plan.mar>');
        const text = readFileSync(file, 'utf8');
        const result = compile(text, { file });
        if (result.diagnostics.length > 0) {
          process.stderr.write(formatDiagnostics(result.diagnostics, file) + '\n');
        }
        const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
        const warnings = result.diagnostics.length - errors;
        process.stderr.write(`${basename(file)}: ${errors} error(s), ${warnings} warning(s)\n`);
        if (!result.ok) return 1;
        if (flags['strict'] && warnings > 0) return 1;
        return 0;
      }

      case 'render': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('render: missing <plan.mar|.json>');
        const { trajectory, ok, diagnostics } = readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file) + '\n');
          return 1;
        }
        let state: PlanState | null = null;
        if (typeof flags['state'] === 'string' || existsSync(stateFileFor(file, flags))) {
          const sf = stateFileFor(file, flags);
          if (existsSync(sf)) state = loadState(trajectory, sf);
        }
        output(flags, null, renderMermaid(trajectory, { state, direction: flags['lr'] ? 'LR' : 'TD' }));
        return 0;
      }

      case 'summarize': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('summarize: missing <plan.mar|.json>');
        const { trajectory, diagnostics } = readSource(file);
        let state: PlanState | null = null;
        const sf = stateFileFor(file, flags);
        if ((typeof flags['state'] === 'string' || existsSync(sf)) && existsSync(sf)) {
          state = loadState(trajectory, sf);
        }
        output(flags, null, summarize(trajectory, { diagnostics, state, file }));
        return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
      }

      case 'state': {
        const [sub, ...stateRest] = rest;
        const { positional, flags } = parseArgs(stateRest);
        const file = positional[0];
        if (!sub || !file) throw new UsageError('state: expected "state <init|show|choose|advance> <plan>"');
        const { trajectory, ok, diagnostics } = readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file) + '\n');
          process.stderr.write('refusing to walk a plan that does not validate\n');
          return 1;
        }
        const sf = stateFileFor(file, flags);

        if (sub === 'init') {
          if (existsSync(sf) && !flags['force']) {
            throw new UsageError(`${sf} already exists; pass --force to reinitialise`);
          }
          const state = initState(trajectory);
          writeFileSync(sf, serializeState(state));
          process.stderr.write(`initialised ${sf} bound to ${trajectory.hash.slice(0, 19)}…\n`);
          printFrontier(trajectory, state);
          return 0;
        }

        const state = loadState(trajectory, sf);
        if (sub === 'show') {
          printFrontier(trajectory, state);
          return 0;
        }
        if (sub === 'choose') {
          const ref = positional[1];
          if (!ref) throw new UsageError('state choose: missing <choice> (index, id, or label prefix)');
          const actor = typeof flags['actor'] === 'string' ? flags['actor'] : 'agent';
          const rationale = typeof flags['rationale'] === 'string' ? flags['rationale'] : undefined;
          takeChoice(trajectory, state, ref, { actor, rationale });
          writeFileSync(sf, serializeState(state));
          printFrontier(trajectory, state);
          return 0;
        }
        if (sub === 'advance') {
          const actor = typeof flags['actor'] === 'string' ? flags['actor'] : 'agent';
          const rationale = typeof flags['rationale'] === 'string' ? flags['rationale'] : undefined;
          advance(trajectory, state, { actor, rationale });
          writeFileSync(sf, serializeState(state));
          printFrontier(trajectory, state);
          return 0;
        }
        throw new UsageError(`unknown state subcommand "${sub}"`);
      }

      default:
        throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof DriftError) {
      process.stderr.write(e.message + '\n');
      return 3;
    }
    if (e instanceof WalkError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

// Self-invoke only when this file is the entrypoint (node dist/cli.js, tsx src/cli.ts).
// The bin shim imports run() and invokes it itself.
const invokedDirectly = process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'));
if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
