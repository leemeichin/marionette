/**
 * Production bridge to the normative Prolog semantics.
 *
 * The wasm instance is lazy and shared. Plan facts are process-global inside
 * SWI-Prolog, so every facts load + query is serialized and the last loaded
 * fact base is cached. Walker state is explicit JSON and never lives in
 * dynamic Prolog predicates.
 */

import type { Value } from './types.ts';
import { MARIONETTE_RULES } from './rules-source.ts';

export interface RuleGraphFinding {
  code: string;
  severity: 'error' | 'warning';
  line: number;
  variant: string | null;
  data: Record<string, unknown>;
}

export interface RuleSemanticState {
  status: 'active' | 'completed';
  current: string;
  variables: Record<string, Value>;
  taken: string[];
  pendingObservations: string[];
  pendingEntry: boolean;
  /** Epoch milliseconds, or -1 once completed. */
  activationStartedAtMs: number;
}

export interface RuleFrontierItem {
  choiceId: string;
  blockedCode: string | null;
  detail: Record<string, unknown>;
}

export interface RuleEffect {
  kind: 'initialized' | 'moved' | 'observed';
  choiceId?: string | null;
  from?: string;
  to?: string;
  name?: string;
}

export type RuleWalkResult =
  | { ok: true; state: RuleSemanticState; effect: RuleEffect }
  | {
      ok: false;
      state: RuleSemanticState;
      code: string;
      detail: Record<string, unknown>;
    };

export interface RuleOracleFinding {
  code: string;
  line: number;
}

export interface RuleOracleReport {
  findings: RuleOracleFinding[];
  cycles: string[][];
  strands: number[];
}

export interface RuleBindings {
  [key: string]: unknown;
}

interface PrologQuery extends Iterable<RuleBindings> {
  once(): RuleBindings;
}

interface SwiplModule {
  prolog: {
    query(goal: string, input?: Record<string, unknown>): PrologQuery;
    load_string(code: string, id?: string): Promise<unknown>;
  };
}

type SwiplFactory = (options?: Record<string, unknown>) => Promise<SwiplModule>;

interface BrowserSwiplGlobal {
  SWIPL?: SwiplFactory;
}

const BROWSER_SWIPL_SCRIPT = '/swipl/swipl-web.js';

function stripEncodingDirective(code: string): string {
  return code.replaceAll(':- encoding(utf8).', '');
}

function prologString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'v' in value) {
    return String((value as { v: unknown }).v);
  }
  return String(value);
}

let enginePromise: Promise<SwiplModule> | null = null;
let factsLoads = 0;
let loadedFacts: string | null = null;
let queue: Promise<void> = Promise.resolve();

function isBrowser(): boolean {
  return typeof document !== 'undefined';
}

async function browserSwiplFactory(): Promise<SwiplFactory> {
  const browser = globalThis as typeof globalThis & BrowserSwiplGlobal;
  if (!browser.SWIPL) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${BROWSER_SWIPL_SCRIPT}"]`,
      );
      const script = existing ?? document.createElement('script');
      const loaded = () => resolve();
      const failed = () => reject(new Error(`failed to load ${BROWSER_SWIPL_SCRIPT}`));
      script.addEventListener('load', loaded, { once: true });
      script.addEventListener('error', failed, { once: true });
      if (!existing) {
        script.src = BROWSER_SWIPL_SCRIPT;
        script.async = true;
        document.head.append(script);
      }
    });
  }
  if (!browser.SWIPL) {
    throw new Error(`${BROWSER_SWIPL_SCRIPT} did not expose SWIPL`);
  }
  return browser.SWIPL;
}

async function engine(): Promise<SwiplModule> {
  enginePromise ??= (async () => {
    const SWIPL = isBrowser()
      ? await browserSwiplFactory()
      : (await import('swipl-wasm')).default as unknown as SwiplFactory;
    const options = isBrowser()
      ? {
          arguments: ['-q'],
          locateFile: (path: string) => `/swipl/${path}`,
        }
      : { arguments: ['-q'] };
    const swipl = await SWIPL(options);
    await swipl.prolog.load_string(
      stripEncodingDirective(MARIONETTE_RULES),
      'marionette_rules',
    );
    return swipl;
  })();
  return enginePromise;
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function loadFacts(swipl: SwiplModule, facts: string): Promise<void> {
  if (loadedFacts === facts) return;
  swipl.prolog.query('reset_plan').once();
  await swipl.prolog.load_string(
    stripEncodingDirective(facts),
    `marionette_facts_${factsLoads++}`,
  );
  loadedFacts = facts;
}

async function withFacts<T>(
  facts: string,
  work: (swipl: SwiplModule) => T | Promise<T>,
): Promise<T> {
  return serialized(async () => {
    const swipl = await engine();
    await loadFacts(swipl, facts);
    return work(swipl);
  });
}

function jsonBinding(
  swipl: SwiplModule,
  goal: string,
  input: Record<string, unknown>,
): unknown {
  const binding = swipl.prolog.query(goal, input).once();
  if (binding['error']) {
    throw new Error(String(binding['message'] ?? 'rule engine query failed'));
  }
  const json = prologString(binding['Json']);
  return JSON.parse(json);
}

export async function ruleGraphFindings(facts: string): Promise<RuleGraphFinding[]> {
  return withFacts(facts, (swipl) => {
    const parsed = jsonBinding(swipl, 'graph_findings_json(Json)', {}) as {
      findings: RuleGraphFinding[];
    };
    return parsed.findings;
  });
}

export async function ruleWalkInit(
  facts: string,
  nowMs: number,
): Promise<RuleWalkResult> {
  return withFacts(facts, (swipl) =>
    jsonBinding(swipl, 'walk_init_json(Now, Json)', { Now: String(nowMs) }) as RuleWalkResult);
}

export async function ruleWalkFrontier(
  facts: string,
  state: RuleSemanticState,
  nowMs: number,
): Promise<RuleFrontierItem[]> {
  return withFacts(facts, (swipl) => {
    const parsed = jsonBinding(
      swipl,
      'walk_frontier_json(StateJson, Now, Json)',
      { StateJson: JSON.stringify(state), Now: String(nowMs) },
    ) as { frontier: RuleFrontierItem[] };
    return parsed.frontier;
  });
}

export async function ruleWalkApply(
  facts: string,
  state: RuleSemanticState,
  operation: Record<string, unknown>,
  nowMs: number,
): Promise<RuleWalkResult> {
  return withFacts(facts, (swipl) =>
    jsonBinding(
      swipl,
      'walk_apply_json(StateJson, OperationJson, Now, Json)',
      {
        StateJson: JSON.stringify(state),
        OperationJson: JSON.stringify(operation),
        Now: String(nowMs),
      },
    ) as RuleWalkResult);
}

export async function ruleOracleReport(facts: string): Promise<RuleOracleReport> {
  return withFacts(facts, (swipl) => {
    const findings = new Map<string, RuleOracleFinding>();
    for (const binding of swipl.prolog.query('finding(Code, Line)')) {
      const finding = {
        code: String(binding['Code']),
        line: Number(binding['Line']),
      };
      findings.set(`${finding.code}:${finding.line}`, finding);
    }

    const cycles = new Map<string, string[]>();
    for (const binding of swipl.prolog.query('undeclared_cycle(Ns)')) {
      const cycle = (binding['Ns'] as unknown[]).map(String);
      cycles.set(cycle.join('->'), cycle);
    }

    const strands = new Set<number>();
    for (const binding of swipl.prolog.query('stranding(_, Line)')) {
      strands.add(Number(binding['Line']));
    }

    return {
      findings: [...findings.values()].sort((a, b) =>
        a.code === b.code ? a.line - b.line : a.code.localeCompare(b.code)),
      cycles: [...cycles.values()],
      strands: [...strands].sort((a, b) => a - b),
    };
  });
}

export async function ruleQuery(
  facts: string,
  goal: string,
  limit = 200,
): Promise<RuleBindings[]> {
  return withFacts(facts, (swipl) => {
    const solutions: RuleBindings[] = [];
    for (const binding of swipl.prolog.query(goal)) {
      const clean: RuleBindings = {};
      for (const [key, value] of Object.entries(binding)) {
        if (key !== '$tag') clean[key] = value;
      }
      solutions.push(clean);
      if (solutions.length >= limit) break;
    }
    // Arbitrary queries may mutate facts; force a clean reload next time.
    loadedFacts = null;
    return solutions;
  });
}
