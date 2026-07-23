/**
 * marionette CLI: compile | validate | render | summarize | brief | state | runtime.
 *
 * Exit codes (CI-suitable):
 *   0  success (warnings allowed unless --strict)
 *   1  validation errors (or warnings with --strict), refused walk operations
 *   2  usage or I/O errors
 *   3  plan/state drift detected
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Diagnostic, PlanState, Trajectory } from './types.js';
import { compile, formatDiagnostics } from './compile.js';
import { renderMermaid } from './render.js';
import { summarize } from './summarize.js';
import { nearest } from './suggest.js';
import { styleFor } from './term.js';
import { buildBrief, renderBrief } from './brief.js';
import {
  DriftError, WalkError, advance, bindState, frontier, initState, parseState,
  rebindState, serializeState, takeChoice,
} from './state.js';
import { RuntimeService, serveRuntimeLines } from './runtime-process.js';
import {
  RuntimeStoreError, claimRuntimeProcess, initializeRuntimeStore, loadRuntimeStore,
  releaseRuntimeProcess, stopRuntimeProcess,
} from './runtime-store.js';
import type { RuntimePrincipal, RuntimeRole } from './runtime-protocol.js';

const err = styleFor(process.stderr);
const out = styleFor(process.stdout);

const COMMANDS = ['compile', 'validate', 'render', 'summarize', 'brief', 'start', 'stop', 'state', 'help', 'version'];
const STATE_SUBCOMMANDS = ['init', 'show', 'choose', 'advance', 'rebind'];

function readTextFile(file: string, what = 'plan'): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    const reason = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'no such file' : (e as Error).message;
    throw new UsageError(`cannot read ${what} ${file}: ${reason}`);
  }
}

function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USAGE = `marionette — compiled project trajectories for AI agents

Usage:
  marionette compile   <plan.mar> [-o out.trajectory.json]   Compile to trajectory JSON
  marionette validate  <plan.mar> [--strict]                 Check only; print diagnostics
  marionette render    <plan.mar|.json> [--state f] [-o out.mmd] [--lr]
  marionette summarize <plan.mar|.json> [--state f] [-o out.md]
  marionette brief     <plan.mar|.json> [--state f] [--json]    Work packet for the executor
  marionette start     <plan.mar|.json> --run <id> [--store dir]
                       [--principal id] [--role agent|human] [--principal-uri uri]
  marionette stop      <plan.mar|.json> --run <id> [--store dir]
  marionette state init    <plan.mar|.json> [--state f] [--force]
  marionette state show    <plan.mar|.json> [--state f]
  marionette state choose  <plan.mar|.json> <choice> --actor <name> --rationale <text> [--state f]
  marionette state advance <plan.mar|.json> --actor <name> [--rationale <text>] [--state f]
  marionette state rebind  <plan.mar|.json> [--state f]         Migrate state onto an edited plan

Options:
  -o, --out <file>    Output file ('-' for stdout; default varies by command)
  --state <file>      State file (default: <plan>.state.json)
  --strict            Treat warnings as errors (exit 1)
  --json              Emit the machine-readable form (brief)
  --lr                Render left-to-right instead of top-down
  --force             Overwrite an existing state file on init
  --actor <name>      Who takes the step ("agent" may not pass @human gates)
  --rationale <text>  Why the step was taken (required for choices)
  --run <id>           Run id (required by start/stop)
  --store <dir>        Run store (default: <plan-dir>/.marionette)
  --create             Start a new run; error if it already exists
  --principal <id>     Connection principal id (default: agent)
  --role <role>        Bound connection role: agent or human (default: agent)
  --principal-uri <u>  Optional provenance URI for decision records
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const takesValue = new Set([
    '-o', '--out', '--state', '--actor', '--rationale',
    '--run', '--store', '--principal', '--role', '--principal-uri',
  ]);
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

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

async function readSource(file: string): Promise<{ trajectory: Trajectory; diagnostics: Diagnostic[]; ok: boolean; source?: string }> {
  const text = readTextFile(file);
  if (file.endsWith('.json')) {
    let trajectory: Trajectory;
    try {
      trajectory = JSON.parse(text) as Trajectory;
    } catch {
      throw new UsageError(`${file} is not valid JSON`);
    }
    if (!trajectory.hash || !trajectory.nodes) throw new UsageError(`${file} is not a trajectory document`);
    return { trajectory, diagnostics: [], ok: true };
  }
  const result = await compile(text, { file });
  if (!result.trajectory) {
    process.stderr.write(formatDiagnostics(result.diagnostics, file, { source: text, style: err }) + '\n');
    throw new UsageError(`${file} did not compile`);
  }
  return { trajectory: result.trajectory, diagnostics: result.diagnostics, ok: result.ok, source: text };
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
  const done = state.status === 'completed' ? out.green(' (completed)') : '';
  process.stdout.write(`current: ${out.bold(state.current)}${done}\n`);
  if (node?.body) process.stdout.write(out.dim(node.body) + '\n');
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
    const marks = [choice.human ? out.magenta('@human') : null, choice.loop ? out.cyan('~loop~') : null,
      choice.gate ? out.dim(`{${choice.gate.source}}`) : null].filter(Boolean).join(' ');
    const line = `  [${i}] ${choice.label}${marks ? ' ' + marks : ''} -> ${choice.target}`;
    process.stdout.write(blocked ? out.dim(`${line}  [unavailable: ${blocked}]`) + '\n' : line + '\n');
  }
  if (node?.divert) process.stdout.write(out.dim(`  (fallthrough) -> ${node.divert.target}\n`));
}

export async function run(argv: string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      process.stdout.write(`marionette ${cliVersion()}\n`);
      return 0;
    }

    switch (command) {
      case 'compile': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('compile: missing <plan.mar>');
        const text = readTextFile(file);
        const result = await compile(text, { file });
        if (result.diagnostics.length > 0) {
          process.stderr.write(formatDiagnostics(result.diagnostics, file, { source: text, style: err }) + '\n');
        }
        if (!result.ok || !result.trajectory) return 1;
        if (flags['strict'] && result.diagnostics.length > 0) return 1;
        const fallback = file.replace(/\.mar$/, '') + '.trajectory.json';
        output(flags, fallback, JSON.stringify(result.trajectory, null, 2) + '\n');
        const choices = result.trajectory.nodes.reduce((n, node) => n + node.choices.length, 0);
        process.stderr.write(err.green('✓') +
          ` compiled ${result.trajectory.nodes.length} phases, ${choices} choices ` +
          err.dim(`(${result.trajectory.hash.slice(0, 19)}…)`) + '\n');
        return 0;
      }

      case 'validate': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('validate: missing <plan.mar>');
        const text = readTextFile(file);
        const result = await compile(text, { file });
        if (result.diagnostics.length > 0) {
          process.stderr.write(formatDiagnostics(result.diagnostics, file, { source: text, style: err }) + '\n');
        }
        const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
        const warnings = result.diagnostics.length - errors;
        const failed = !result.ok || (Boolean(flags['strict']) && warnings > 0);
        const mark = failed ? err.red('✗') : err.green('✓');
        const counts = `${count(errors, 'error')}, ${count(warnings, 'warning')}`;
        process.stderr.write(`${mark} ${basename(file)}: ${counts}\n`);
        if (!result.ok) return 1;
        if (flags['strict'] && warnings > 0) {
          process.stderr.write(err.dim('  (--strict treats warnings as failures; zero errors is the authoring bar)\n'));
          return 1;
        }
        return 0;
      }

      case 'render': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('render: missing <plan.mar|.json>');
        const { trajectory, ok, diagnostics, source } = await readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file, { source, style: err }) + '\n');
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
        const { trajectory, diagnostics } = await readSource(file);
        let state: PlanState | null = null;
        const sf = stateFileFor(file, flags);
        if ((typeof flags['state'] === 'string' || existsSync(sf)) && existsSync(sf)) {
          state = loadState(trajectory, sf);
        }
        output(flags, null, summarize(trajectory, { diagnostics, state, file }));
        return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
      }

      case 'brief': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('brief: missing <plan.mar|.json>');
        const { trajectory, ok, diagnostics, source } = await readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file, { source, style: err }) + '\n');
          process.stderr.write('refusing to brief on a plan that does not validate\n');
          return 1;
        }
        const sf = stateFileFor(file, flags);
        const state = loadState(trajectory, sf);
        const brief = buildBrief(trajectory, state, { file });
        if (flags['json']) {
          output(flags, null, JSON.stringify(brief, null, 2) + '\n');
        } else {
          output(flags, null, renderBrief(brief, out));
        }
        return 0;
      }

      case 'start':
      case 'runtime': { // compatibility alias for pre-0.2 callers
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('start: missing <plan.mar|.json>');
        const runId = typeof flags['run'] === 'string' ? flags['run'] : undefined;
        if (!runId) throw new UsageError('start: missing required --run <id>');
        const role = (typeof flags['role'] === 'string' ? flags['role'] : 'agent') as RuntimeRole;
        if (role !== 'agent' && role !== 'human') {
          throw new UsageError('start: --role must be agent or human');
        }
        const principal: RuntimePrincipal = {
          id: typeof flags['principal'] === 'string' ? flags['principal'] : role,
          role,
          uri: typeof flags['principal-uri'] === 'string' ? flags['principal-uri'] : undefined,
        };
        const { trajectory, ok, diagnostics, source } = await readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file, { source, style: err }) + '\n');
          process.stderr.write('refusing to start: the plan does not validate\n');
          return 1;
        }
        const store = typeof flags['store'] === 'string'
          ? resolve(flags['store'])
          : join(dirname(resolve(file)), '.marionette');
        let snapshot;
        let created = false;
        try {
          if (flags['create']) {
            snapshot = await initializeRuntimeStore(store, trajectory, { runId, principal });
            created = true;
          } else {
            try {
              snapshot = loadRuntimeStore(store, runId, trajectory);
            } catch (error) {
              if (!(error instanceof RuntimeStoreError) || error.code !== 'run-not-found') throw error;
              snapshot = await initializeRuntimeStore(store, trajectory, { runId, principal });
              created = true;
            }
          }
          claimRuntimeProcess(store, runId, trajectory.hash);
        } catch (error) {
          if (error instanceof RuntimeStoreError) {
            throw new UsageError(`start: ${error.message}`);
          }
          throw error;
        }
        process.stderr.write(
          `✓ Marionette ${created ? 'started' : 'resumed'} · ${runId} · ` +
          `revision ${snapshot.revision} · ${role}:${principal.id}\n` +
          '  listening on stdin/stdout · press Ctrl-C to stop\n',
        );
        const stopOnSignal = () => {
          releaseRuntimeProcess(store, runId, trajectory.hash);
          process.exit(0);
        };
        process.once('SIGINT', stopOnSignal);
        process.once('SIGTERM', stopOnSignal);
        try {
          await serveRuntimeLines(
            new RuntimeService(trajectory, snapshot, store, principal),
            { input: process.stdin, output: process.stdout, diagnostics: process.stderr },
          );
        } finally {
          process.off('SIGINT', stopOnSignal);
          process.off('SIGTERM', stopOnSignal);
          releaseRuntimeProcess(store, runId, trajectory.hash);
        }
        return 0;
      }

      case 'stop': {
        const { positional, flags } = parseArgs(rest);
        const file = positional[0];
        if (!file) throw new UsageError('stop: missing <plan.mar|.json>');
        const runId = typeof flags['run'] === 'string' ? flags['run'] : undefined;
        if (!runId) throw new UsageError('stop: missing required --run <id>');
        const { trajectory, ok, diagnostics, source } = await readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file, { source, style: err }) + '\n');
          return 1;
        }
        const store = typeof flags['store'] === 'string'
          ? resolve(flags['store'])
          : join(dirname(resolve(file)), '.marionette');
        try {
          const result = stopRuntimeProcess(store, runId, trajectory.hash);
          if (result.status === 'not-running') {
            process.stderr.write(`· ${runId} is already stopped\n`);
          } else {
            process.stderr.write(`✓ stop requested · ${runId} · pid ${result.pid}\n`);
          }
          return 0;
        } catch (error) {
          if (error instanceof RuntimeStoreError) throw new UsageError(`stop: ${error.message}`);
          throw error;
        }
      }

      case 'state': {
        const [sub, ...stateRest] = rest;
        const { positional, flags } = parseArgs(stateRest);
        const file = positional[0];
        if (!sub || !file) throw new UsageError('state: expected "state <init|show|choose|advance> <plan>"');
        const { trajectory, ok, diagnostics, source } = await readSource(file);
        if (!ok) {
          process.stderr.write(formatDiagnostics(diagnostics, file, { source, style: err }) + '\n');
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

        if (sub === 'rebind') {
          if (!existsSync(sf)) {
            throw new UsageError(`no state file at ${sf}; run "marionette state init" first`);
          }
          const state = parseState(readFileSync(sf, 'utf8'));
          const report = rebindState(trajectory, state);
          if (report.fromHash === report.toHash) {
            process.stderr.write('state is already bound to this plan; nothing to migrate\n');
            return 0;
          }
          writeFileSync(sf, serializeState(state));
          process.stderr.write(err.green('✓') + ` migrated ${sf}\n` +
            err.dim(`  from ${report.fromHash.slice(0, 19)}…\n  to   ${report.toHash.slice(0, 19)}…\n`));
          const note = (label: string, items: string[]) => {
            if (items.length > 0) process.stderr.write(`  ${label}: ${items.join(', ')}\n`);
          };
          note('dropped taken choices', report.droppedTaken);
          note('dropped variables', Object.keys(report.droppedVariables));
          note('added variables', Object.entries(report.addedVariables).map(([k, v]) => `${k}=${JSON.stringify(v)}`));
          note('reset variables (type changed)', report.resetVariables);
          note('visited phases no longer in the plan', report.missingVisited);
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
        {
          const near = nearest(sub, STATE_SUBCOMMANDS);
          const hint = near ? `; did you mean "state ${near}"?` : '';
          throw new UsageError(`unknown state subcommand "${sub}"${hint}`);
        }
      }

      default: {
        const near = nearest(command, COMMANDS);
        const hint = near ? `; did you mean "${near}"?` : '';
        throw new UsageError(`unknown command "${command}"${hint}\n\n${USAGE}`);
      }
    }
  } catch (e) {
    if (e instanceof DriftError) {
      process.stderr.write(e.message + '\n');
      return 3;
    }
    if (e instanceof WalkError) {
      process.stderr.write(`${err.red('error:')} ${e.message}\n`);
      return 1;
    }
    if (e instanceof UsageError) {
      process.stderr.write(`${err.red('error:')} ${e.message}\n`);
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
  process.exit(await run(process.argv.slice(2)));
}
