/**
 * Presentation layer for semantic findings and walk refusals.
 *
 * The semantic cores stay English-free: the validator (validate.ts) emits
 * `Finding`s — code, location, structured slots — and the walker (state.ts)
 * refuses with a code and slots. This module owns every human-facing
 * sentence, so the semantic layer can be compared 1:1 against the rule base
 * (spec/rules/marionette.pl) with presentation excluded by construction.
 *
 * Message shapes here are load-bearing: the docs-site transcripts capture
 * them byte-for-byte. Changing a sentence means recapturing
 * (docs-site/build/capture.mjs).
 */

import type { Diagnostic, Finding } from './types.js';
import { END } from './types.js';
import { nearest } from './suggest.js';

const s = (f: Finding, key: string): string => String(f.data[key]);

/** did-you-mean, or a fallback suggestion when nothing is close. */
function suggest(name: string, candidates: string[], fallback?: string): string | undefined {
  const near = nearest(name, candidates);
  return near ? `did you mean "${near}"?` : fallback;
}

/** Phrase one semantic finding as a user-facing diagnostic. */
export function renderFinding(f: Finding): Diagnostic {
  const d = ((): { message: string; suggestion?: string } => {
    switch (`${f.code}${f.variant ? `:${f.variant}` : ''}`) {
      case 'MAR001:no-phases':
        return { message: 'plan has no phases', suggestion: 'add at least one "=== phase ===" section' };
      case 'MAR003:start':
        return {
          message: `start divert targets undefined phase "${s(f, 'target')}"`,
          suggestion: suggest(s(f, 'target'), f.data['candidates'] as string[]),
        };
      case 'MAR003':
        return {
          message: `${s(f, 'subject')} targets undefined phase "${s(f, 'target')}"`,
          suggestion: suggest(s(f, 'target'), f.data['candidates'] as string[],
            `declare "=== ${s(f, 'target')} ===" or divert to ${END}`),
        };
      case 'MAR004:mutation':
        return {
          message: `mutation of undefined variable "${s(f, 'name')}"`,
          suggestion: suggest(s(f, 'name'), f.data['candidates'] as string[],
            `declare it in the preamble: VAR ${s(f, 'name')} = ...`),
        };
      case 'MAR004':
        return {
          message: `undefined variable "${s(f, 'name')}" in ${s(f, 'context')}`,
          suggestion: suggest(s(f, 'name'), f.data['candidates'] as string[],
            `declare it in the preamble: VAR ${s(f, 'name')} = ...`),
        };
      case 'MAR006':
        return {
          message: `phase "${s(f, 'id')}" is a dead end: no choices and no divert`,
          suggestion: `add a choice or divert (e.g. "-> ${END}") so every path has an exit`,
        };
      case 'MAR007':
        return {
          message: `phase "${s(f, 'id')}" is unreachable from "${s(f, 'start')}"`,
          suggestion: 'divert or link a choice to it, or remove it',
        };
      case 'MAR008':
        return {
          message: `undeclared cycle: ${s(f, 'path')}`,
          suggestion: 'cycles must be intentional: mark the returning choice with ~loop~',
        };
      case 'MAR009':
        return {
          message: `potential infinite loop: the cycle through "${s(f, 'id')}" has no exit path`,
          suggestion: 'add a sibling choice or divert that leaves the loop (e.g. a counter-gated exit or an @human decision)',
        };
      case 'MAR010':
        return {
          message: `potential infinite loop: no exit gate of the cycle through "${s(f, 'id')}" is satisfiable`,
          suggestion: 'ensure at least one exit gate can become true (e.g. a monotonic counter), or remove its gate',
        };
      case 'MAR011':
        return {
          message: `choice "${s(f, 'label')}" can never be taken: ${s(f, 'reason')}`,
          suggestion: 'remove the choice or fix the gate',
        };
      case 'MAR013':
        return {
          message: `choice "${s(f, 'label')}" is marked ~loop~ but does not close a cycle`,
          suggestion: 'remove ~loop~, or point the choice back into the loop',
        };
      case 'MAR014:loop-exit':
        return {
          message: `unverified gate — review manually: cannot statically verify loop exit {${s(f, 'source')}}`,
          suggestion: 'the compiler only verifies constant gates and monotonic counters; confirm this exit can occur',
        };
      case 'MAR014':
        return {
          message: `unverified gate — review manually: {${s(f, 'source')}} on choice "${s(f, 'label')}"`,
          suggestion: 'the compiler only verifies constant gates and monotonic counters',
        };
      case 'MAR015:op-non-number':
        return { message: `"${s(f, 'op')}" requires a number, but "${s(f, 'var')}" is a ${s(f, 'type')}` };
      case 'MAR015:op-value-non-number':
        return { message: `"${s(f, 'op')}" requires a numeric value, got ${s(f, 'valueType')}` };
      case 'MAR015:assign-mismatch':
        return { message: `cannot assign ${s(f, 'valueType')} to "${s(f, 'var')}" (declared ${s(f, 'declType')})` };
      case 'MAR016':
        return { message: `variable "${s(f, 'name')}" is declared but never used` };
      case 'MAR017':
        return {
          message: `loop choice "${s(f, 'label')}" is once-only ("*") and can iterate at most once`,
          suggestion: 'use a sticky choice ("+") so the loop can be taken repeatedly',
        };
      case 'MAR023':
        return {
          message: `phase "${s(f, 'id')}" has a timebox but only one exit: spending or not spending the budget leads to the same place`,
          suggestion: 'a speculative phase needs both a "worked" and an "abandon" door — or drop the timebox',
        };
      default:
        return { message: `${f.code}: ${JSON.stringify(f.data)}` };
    }
  })();
  return { severity: f.severity, code: f.code, message: d.message, line: f.line, suggestion: d.suggestion };
}

/* ---- Walk refusals -------------------------------------------------------
 * One entry per refusal shape (a WalkErrorCode can have several). The walker
 * passes slots; the sentence lives here.
 */

export type RefusalShape =
  | { kind: 'completed' }
  | { kind: 'unknown-node'; id: string }
  | { kind: 'not-available'; label: string; blocked: string }
  | { kind: 'human-checkpoint'; label: string }
  | { kind: 'rationale-human'; label: string }
  | { kind: 'rationale-missing' }
  | { kind: 'no-divert'; id: string }
  | { kind: 'no-choices'; id: string; divertTarget: string | null }
  | { kind: 'bad-index'; id: string; index: number; max: number }
  | { kind: 'ambiguous'; ref: string; id: string }
  | { kind: 'no-match'; ref: string; id: string; available: string }
  | { kind: 'invalid-state'; key: string }
  | { kind: 'migration-blocked'; current: string };

export function refusalText(shape: RefusalShape): string {
  switch (shape.kind) {
    case 'completed': return 'plan is already completed';
    case 'unknown-node': return `node "${shape.id}" does not exist in the compiled plan`;
    case 'not-available': return `choice "${shape.label}" is not available: ${shape.blocked}`;
    case 'human-checkpoint':
      return `choice "${shape.label}" is an @human checkpoint: an agent may not take it autonomously. ` +
        'Escalate to a human; a human records the decision with --actor <name>.';
    case 'rationale-human':
      return `@human checkpoint "${shape.label}" requires --rationale (the decision must be auditable)`;
    case 'rationale-missing': return 'every taken branch must record a rationale: pass --rationale (G4)';
    case 'no-divert': return `phase "${shape.id}" has no divert; take one of its choices instead`;
    case 'no-choices':
      return `phase "${shape.id}" has no choices` + (shape.divertTarget
        ? `; it diverts to "${shape.divertTarget}" — use "marionette state advance"` : '');
    case 'bad-index':
      return `phase "${shape.id}" has no choice at index ${shape.index} (valid: 0..${shape.max})`;
    case 'ambiguous': return `choice reference "${shape.ref}" is ambiguous at "${shape.id}"`;
    case 'no-match': return `no choice "${shape.ref}" at phase "${shape.id}"; available: ${shape.available}`;
    case 'invalid-state': return `invalid state file: missing "${shape.key}"`;
    case 'migration-blocked':
      return `cannot migrate: current phase "${shape.current}" no longer exists in the plan. ` +
        'Review the plan changes, then either restore the phase or re-initialise the state.';
  }
}

/** Availability explanations shown on blocked frontier entries. */
export function blockedText(
  shape: { kind: 'once-exhausted' } | { kind: 'gate-false'; source: string; value: string }
       | { kind: 'gate-error'; source: string; error: string },
): string {
  switch (shape.kind) {
    case 'once-exhausted': return 'already taken (once-only choice)';
    case 'gate-false': return `gate {${shape.source}} is ${shape.value}`;
    case 'gate-error': return `gate {${shape.source}} failed to evaluate: ${shape.error}`;
  }
}
