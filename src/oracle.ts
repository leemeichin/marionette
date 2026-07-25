/**
 * In-process rule engine: spec/rules/marionette.pl running on the bundled
 * SWI-Prolog WebAssembly build (swipl-wasm), so the oracle report and the
 * query surface work wherever the npm package installs — self-contained, no
 * system Prolog. One engine is created lazily and reused across plans via
 * the rule base's reset_plan/0.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface OracleFinding {
  code: string;
  line: number;
}

export interface OracleReport {
  /** MAR findings, deduplicated, sorted by code then line. */
  findings: OracleFinding[];
  /** MAR008 semantic form: effective simple cycles with no ~loop~ edge. */
  cycles: string[][];
  /** STRAND lines: once-only choices on a cycle (issue #8 item 2). */
  strands: number[];
}

interface Bindings {
  [key: string]: unknown;
}

interface SwiplModule {
  prolog: {
    query(goal: string): Iterable<Bindings> & { once(): Bindings };
    load_string(code: string, id?: string): Promise<unknown>;
  };
}

const RULES_PATH = fileURLToPath(new URL('../spec/rules/marionette.pl', import.meta.url));

/** JS strings are already Unicode; the encoding directive is for file consult
 * with native swipl and is rejected on the wasm build's string streams. */
function stripEncodingDirective(code: string): string {
  return code.replaceAll(':- encoding(utf8).', '');
}

let enginePromise: Promise<SwiplModule> | null = null;
let factsLoads = 0;

async function engine(): Promise<SwiplModule> {
  enginePromise ??= (async () => {
    const SWIPL = (await import('swipl-wasm')).default;
    const swipl = (await SWIPL({ arguments: ['-q'] })) as unknown as SwiplModule;
    await swipl.prolog.load_string(stripEncodingDirective(readFileSync(RULES_PATH, 'utf8')), 'marionette_rules');
    return swipl;
  })();
  return enginePromise;
}

async function withFacts(facts: string): Promise<SwiplModule> {
  const swipl = await engine();
  swipl.prolog.query('reset_plan').once();
  await swipl.prolog.load_string(stripEncodingDirective(facts), `marionette_facts_${factsLoads++}`);
  return swipl;
}

/** Run the rule base over a fact base (from emitFacts) and collect findings. */
export async function oracleReport(facts: string): Promise<OracleReport> {
  const swipl = await withFacts(facts);

  const findings = new Map<string, OracleFinding>();
  for (const b of swipl.prolog.query('finding(Code, Line)')) {
    const f = { code: String(b['Code']), line: Number(b['Line']) };
    findings.set(`${f.code}:${f.line}`, f);
  }

  const cycles = new Map<string, string[]>();
  for (const b of swipl.prolog.query('undeclared_cycle(Ns)')) {
    const cycle = (b['Ns'] as unknown[]).map(String);
    cycles.set(cycle.join('->'), cycle);
  }

  const strands = new Set<number>();
  for (const b of swipl.prolog.query('stranding(_, Line)')) strands.add(Number(b['Line']));

  return {
    findings: [...findings.values()].sort((a, b) =>
      a.code === b.code ? a.line - b.line : a.code.localeCompare(b.code)),
    cycles: [...cycles.values()],
    strands: [...strands].sort((a, b) => a - b),
  };
}

/* ---- The rule-base walker (issue #21 phase C) ---------------------------
 * Drives the walker semantics stated in spec/rules/marionette.pl §7 so the
 * conformance suite can hold BOTH walkers (src/state.ts and the rules) to
 * the same cases. Timestamps and the decision log stay driver-side.
 */

export interface WalkSnapshot {
  current: string;
  status: 'active' | 'completed';
  variables: Record<string, number | boolean | string>;
}

export interface PrologWalker {
  /** Returns the refusal code, or null when the operation succeeded. */
  choose(ref: string, actor: string, hasRationale: boolean): string | null;
  advance(): string | null;
  snapshot(): WalkSnapshot;
}

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function prologWalker(facts: string): Promise<PrologWalker> {
  const swipl = await withFacts(facts);
  swipl.prolog.query('init_walk').once();

  const outcome = (goal: string): string | null => {
    const b = swipl.prolog.query(goal).once();
    const code = String(b['Outcome']);
    return code === 'ok' ? null : code;
  };

  return {
    choose: (ref, actor, hasRationale) =>
      outcome(`drive_choose(${q(ref)}, ${q(actor)}, ${hasRationale ? 'true' : 'false'}, Outcome)`),
    advance: () => outcome('drive_advance(Outcome)'),
    snapshot: () => {
      const current = String(swipl.prolog.query('w_current(N)').once()['N']);
      const status = String(swipl.prolog.query('w_status(S)').once()['S']) as WalkSnapshot['status'];
      const variables: WalkSnapshot['variables'] = {};
      for (const b of swipl.prolog.query('walk_var(Name, Type, V)')) {
        const type = String(b['Type']);
        variables[String(b['Name'])] =
          type === 'number' ? Number(b['V'])
          : type === 'boolean' ? String(b['V']) === 'true'
          : String(b['V']);
      }
      return { current, status, variables };
    },
  };
}

/**
 * Run an arbitrary goal against a plan's fact base. Returns one bindings
 * object per solution; a variable-free goal yields [{}] for true, [] for
 * false. Solutions are capped to keep runaway goals bounded.
 */
export async function oracleQuery(facts: string, goal: string, limit = 200): Promise<Bindings[]> {
  const swipl = await withFacts(facts);
  const solutions: Bindings[] = [];
  for (const b of swipl.prolog.query(goal)) {
    const clean: Bindings = {};
    for (const [k, v] of Object.entries(b)) if (k !== '$tag') clean[k] = v;
    solutions.push(clean);
    if (solutions.length >= limit) break;
  }
  return solutions;
}
