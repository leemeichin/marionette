/**
 * Differential oracle: the Prolog rule base (spec/rules/marionette.pl) must
 * agree with the TypeScript validator on every plan in the repo — the
 * dogfood corpus, examples, live plans, fixtures — and on a deterministic
 * batch of graph mutations of each (seeded defects: dropped exits, unmarked
 * loops, false gates, retargeted edges).
 *
 * The rules run on the bundled SWI-Prolog wasm engine (src/oracle.ts), so
 * the suite is self-contained — no system Prolog required, anywhere.
 *
 * Exact-match codes are compared as (code, line) sets. MAR008 is compared
 * on presence only: the rules state the semantic form (every simple cycle
 * carries a ~loop~ edge) while the TS validator approximates it with DFS
 * back edges, so per-cycle reports legitimately differ.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Diagnostic } from '../src/types.js';
import { parsePlan, type ParsedPlan } from '../src/parser.js';
import { validatePlan } from '../src/validate.js';
import { emitFacts } from '../src/facts.js';
import { oracleReport } from '../src/oracle.js';

const ROOT = join(import.meta.dirname, '..');

/** Codes the rule base implements with exact (code, line) agreement. */
const EXACT = new Set(['MAR006', 'MAR007', 'MAR009', 'MAR010', 'MAR011', 'MAR013', 'MAR014', 'MAR017']);
/** Error codes emitted before graph analysis: their presence means the TS
 * validator bailed, so there is nothing to diff. */
const PRE_GRAPH = new Set(['MAR001', 'MAR002', 'MAR003', 'MAR004', 'MAR005', 'MAR012', 'MAR015']);

const MUTANTS_PER_PLAN = 8;

function corpus(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mar')) files.push(path);
    }
  };
  for (const dir of ['examples', 'plans', 'docs/dogfood', 'tests/fixtures']) walk(join(ROOT, dir));
  return files.sort();
}

interface Verdict {
  exact: string[];          // sorted "CODE:line"
  hasUndeclaredCycle: boolean;
  strandLines: number[];    // novel rule, informational
}

function tsVerdict(plan: ParsedPlan): Verdict | null {
  const diagnostics: Diagnostic[] = [...plan.diagnostics];
  validatePlan(plan, diagnostics);
  if (diagnostics.some((d) => d.severity === 'error' && PRE_GRAPH.has(d.code))) return null;
  const exact = diagnostics
    .filter((d) => EXACT.has(d.code))
    .map((d) => `${d.code}:${d.line}`)
    .sort();
  return {
    exact: [...new Set(exact)],
    hasUndeclaredCycle: diagnostics.some((d) => d.code === 'MAR008'),
    strandLines: [],
  };
}

async function prologVerdict(plan: ParsedPlan): Promise<Verdict> {
  const report = await oracleReport(emitFacts(plan));
  return {
    exact: report.findings.map((f) => `${f.code}:${f.line}`).sort(),
    hasUndeclaredCycle: report.cycles.length > 0,
    strandLines: report.strands,
  };
}

/** Deterministic single-defect mutants of a plan, in a fixed operator order. */
function mutants(plan: ParsedPlan): Array<{ name: string; plan: ParsedPlan }> {
  const out: Array<{ name: string; plan: ParsedPlan }> = [];
  const clone = () => structuredClone(plan);

  plan.nodes.forEach((node, n) => {
    if (node.divert) {
      const m = clone();
      m.nodes[n].divert = null;
      out.push({ name: `drop-divert:${node.id}`, plan: m });
    }
    if (node.actions.length > 0) {
      const m = clone();
      m.nodes[n].actions = [];
      out.push({ name: `clear-actions:${node.id}`, plan: m });
    }
    node.choices.forEach((choice, c) => {
      const mutate = (name: string, fn: (p: ParsedPlan) => void) => {
        const m = clone();
        fn(m);
        out.push({ name: `${name}:${choice.id}`, plan: m });
      };
      mutate('drop-choice', (p) => void p.nodes[n].choices.splice(c, 1));
      if (choice.loop) mutate('unmark-loop', (p) => void (p.nodes[n].choices[c].loop = false));
      else mutate('mark-loop', (p) => void (p.nodes[n].choices[c].loop = true));
      if (choice.sticky) mutate('onceify', (p) => void (p.nodes[n].choices[c].sticky = false));
      mutate('gate-false', (p) => void (p.nodes[n].choices[c].gate = {
        source: 'false',
        ast: { kind: 'lit', value: false },
      }));
      if (plan.start && choice.target !== plan.start) {
        mutate('retarget-start', (p) => void (p.nodes[n].choices[c].target = p.start!));
      }
    });
  });

  // Round-robin across operators so a capped batch still mixes defect classes.
  const byOp = new Map<string, Array<{ name: string; plan: ParsedPlan }>>();
  for (const m of out) {
    const op = m.name.split(':')[0];
    (byOp.get(op) ?? byOp.set(op, []).get(op)!).push(m);
  }
  const picked: Array<{ name: string; plan: ParsedPlan }> = [];
  const queues = [...byOp.values()];
  for (let i = 0; picked.length < MUTANTS_PER_PLAN; i++) {
    const queue = queues[i % queues.length];
    const next = queue.shift();
    if (next) picked.push(next);
    if (queues.every((q) => q.length === 0)) break;
  }
  return picked;
}

test('prolog oracle agrees with the TypeScript validator', async (t) => {
  const novel: string[] = [];
  let compared = 0;

  const compare = async (name: string, plan: ParsedPlan) => {
    const ts = tsVerdict(plan);
    if (ts === null) return; // validator bailed before graph analysis
    const pl = await prologVerdict(plan);
    assert.deepEqual(pl.exact, ts.exact,
      `${name}: exact diagnostics diverge\n  ts:     ${ts.exact.join(' ') || '(none)'}\n  prolog: ${pl.exact.join(' ') || '(none)'}`);
    if (ts.hasUndeclaredCycle && !pl.hasUndeclaredCycle) {
      assert.fail(`${name}: TS reports MAR008 but the rules find no uncovered cycle`);
    }
    if (!ts.hasUndeclaredCycle && pl.hasUndeclaredCycle) {
      // The semantic rule is strictly stronger than the DFS approximation:
      // an extra cycle here is a finding, not a mismatch. Surface it.
      novel.push(`${name}: rules found an undeclared cycle the DFS pass missed`);
    }
    if (pl.strandLines.length > 0) {
      novel.push(`${name}: once-only choice on a cycle (STRAND) at line(s) ${pl.strandLines.join(', ')}`);
    }
    compared++;
  };

  for (const file of corpus()) {
    const name = relative(ROOT, file);
    const plan = parsePlan(readFileSync(file, 'utf8'));
    if (plan.diagnostics.some((d) => d.severity === 'error')) continue;
    await t.test(name, async () => {
      await compare(name, plan);
      for (const m of mutants(plan)) await compare(`${name} [${m.name}]`, m.plan);
    });
  }

  assert.ok(compared > 40, `expected a substantial corpus, compared only ${compared} plans`);
  if (novel.length > 0) {
    console.warn(`oracle: ${novel.length} novel finding(s) beyond the TS validator:`);
    for (const n of novel) console.warn(`  - ${n}`);
  }
});
