/**
 * Line-oriented parser for the Marionette DSL (.mar).
 *
 * Grammar (v0):
 *   // comment                                anywhere (stripped)
 *   VAR name = <literal>                      preamble: typed variable declaration
 *   -> target                                 preamble: explicit start divert
 *   # key: value   |   # tag                  metadata tag (plan-level in preamble, node-level in a phase)
 *   === phase_name ===                        phase (node) header
 *   prose...                                  phase body
 *   ~ name (=|+=|-=) expr                     mutation, applied on node entry
 *   * {gate} [Label] @human ~loop~ -> target  once-only choice (gate/@human/~loop~ optional)
 *   + {gate} [Label] -> target                sticky (repeatable) choice
 *   -> target                                 fallthrough divert (target may be END)
 */

import type {
  Action, Choice, Diagnostic, Divert, TrajectoryNode, VariableDecl, Value,
} from './types.js';
import { CODES, END } from './types.js';
import { ExprError, parseExpr, tryConstEval, typeOf } from './expr.js';

export interface ParsedPlan {
  variables: Record<string, VariableDecl>;
  start: string | null;
  nodes: TrajectoryNode[];
  meta: Record<string, string | string[]>;
  diagnostics: Diagnostic[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strip a // comment that is not inside a string literal. A comment only
 * starts at the beginning of the line or after whitespace, so URLs in
 * metadata ("# ref: https://…") survive.
 */
function stripComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function addTagValue(meta: Record<string, string | string[]>, key: string, value: string): void {
  const prev = meta[key];
  if (prev === undefined) meta[key] = value;
  else if (Array.isArray(prev)) prev.push(value);
  else meta[key] = [prev, value];
}

function addTag(meta: Record<string, string | string[]>, raw: string): void {
  // "key: value" — the key may itself be namespaced ("github:issue: 42"), so
  // split at the first colon that is followed by whitespace.
  const kv = raw.match(/^(.+?):\s+(.+)$/);
  if (kv) {
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (IDENT.test(key.replace(/[.:/-]/g, '_'))) {
      addTagValue(meta, key, value);
      return;
    }
  }
  const tags = (meta['tags'] as string[] | undefined) ?? [];
  tags.push(raw.trim());
  meta['tags'] = tags;
}

export function parsePlan(source: string): ParsedPlan {
  const diagnostics: Diagnostic[] = [];
  const variables: Record<string, VariableDecl> = {};
  const nodes: TrajectoryNode[] = [];
  const planMeta: Record<string, string | string[]> = {};
  let start: string | null = null;
  let current: TrajectoryNode | null = null;
  const bodyLines = new Map<string, string[]>();

  const error = (line: number, code: string, message: string, suggestion?: string) =>
    diagnostics.push({ severity: 'error', code, message, line, suggestion });

  // An open fenced metadata value: # key: """ … """ — a container for
  // markdown, collected verbatim (no comment stripping, no trimming).
  let fence: { key: string; target: Record<string, string | string[]>; lines: string[]; line: number } | null = null;

  const lines = source.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    if (fence) {
      if (lines[idx].trim() === '"""') {
        addTagValue(fence.target, fence.key, fence.lines.join('\n'));
        fence = null;
      } else {
        fence.lines.push(lines[idx]);
      }
      continue;
    }
    const line = stripComment(lines[idx]).trim();
    if (line.length === 0) continue;

    // Phase header: === name === (trailing === optional)
    const header = line.match(/^={2,}\s*([^=\s]+)\s*=*$/);
    if (header) {
      const name = header[1];
      if (!IDENT.test(name)) {
        error(lineNo, CODES.PARSE, `invalid phase name "${name}"`,
          'phase names must match [A-Za-z_][A-Za-z0-9_]*');
        current = null;
        continue;
      }
      if (name === END) {
        error(lineNo, CODES.PARSE, `"${END}" is reserved and cannot be used as a phase name`);
        current = null;
        continue;
      }
      if (nodes.some((n) => n.id === name)) {
        error(lineNo, CODES.DUPLICATE_PHASE, `duplicate phase "${name}"`,
          'phase names must be unique; rename one of the occurrences');
        current = null;
        continue;
      }
      current = { id: name, body: '', actions: [], choices: [], divert: null, line: lineNo, meta: {}, refs: [] };
      nodes.push(current);
      bodyLines.set(name, []);
      continue;
    }

    // Tag: # key: value | # tag | # key: """ (fenced markdown value)
    const tag = line.match(/^#\s*(.+)$/);
    if (tag) {
      const fenced = tag[1].match(/^(.+?):\s+"""\s*$/);
      if (fenced) {
        fence = { key: fenced[1].trim(), target: current ? current.meta : planMeta, lines: [], line: lineNo };
        continue;
      }
      addTag(current ? current.meta : planMeta, tag[1]);
      continue;
    }

    // VAR declaration (preamble only)
    const varDecl = line.match(/^VAR\s+([^\s=]+)\s*=\s*(.+)$/);
    if (varDecl) {
      const [, name, rawValue] = varDecl;
      if (current) {
        error(lineNo, CODES.PARSE, 'VAR declarations must appear before the first phase',
          `move "VAR ${name} = ..." above the first "=== phase ===" header`);
        continue;
      }
      if (!IDENT.test(name)) {
        error(lineNo, CODES.PARSE, `invalid variable name "${name}"`);
        continue;
      }
      if (name in variables) {
        error(lineNo, CODES.DUPLICATE_VARIABLE, `duplicate variable "${name}"`,
          'variables may only be declared once');
        continue;
      }
      let value: Value | undefined;
      try {
        value = tryConstEval(parseExpr(rawValue));
      } catch (e) {
        error(lineNo, CODES.PARSE, `invalid initial value for "${name}": ${(e as Error).message}`);
        continue;
      }
      if (value === undefined) {
        error(lineNo, CODES.PARSE, `initial value for "${name}" must be a constant`,
          'use a number, true/false, or a "string" literal');
        continue;
      }
      variables[name] = { type: typeOf(value), initial: value, line: lineNo };
      continue;
    }

    // Mutation: ~ name op expr
    if (line.startsWith('~')) {
      const mut = line.slice(1).trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|=)\s*(.+)$/);
      if (!mut) {
        error(lineNo, CODES.PARSE, `invalid mutation "${line}"`,
          'expected "~ name = expr", "~ name += expr" or "~ name -= expr"');
        continue;
      }
      if (!current) {
        error(lineNo, CODES.PARSE, 'mutations must appear inside a phase');
        continue;
      }
      if (current.divert) {
        error(lineNo, CODES.PARSE, 'statement after divert is unreachable',
          'move this line above the "->" divert');
        continue;
      }
      const [, name, op, rawExpr] = mut;
      try {
        const value = parseExpr(rawExpr);
        current.actions.push({ var: name, op: op as Action['op'], value, source: rawExpr.trim(), line: lineNo });
      } catch (e) {
        error(lineNo, CODES.PARSE, `invalid expression in mutation of "${name}": ${(e as Error).message}`);
      }
      continue;
    }

    // Choice: * / +
    if (line.startsWith('*') || line.startsWith('+')) {
      const sticky = line.startsWith('+');
      if (!current) {
        error(lineNo, CODES.PARSE, 'choices must appear inside a phase');
        continue;
      }
      if (current.divert) {
        error(lineNo, CODES.PARSE, 'choice after divert is unreachable',
          'move choices above the "->" divert');
        continue;
      }
      const choice = parseChoice(line.slice(1).trim(), current, sticky, lineNo, error);
      if (choice) current.choices.push(choice);
      continue;
    }

    // Divert: -> target
    const divert = line.match(/^->\s*(\S+)\s*$/);
    if (divert) {
      const target = divert[1];
      if (!IDENT.test(target)) {
        error(lineNo, CODES.PARSE, `invalid divert target "${target}"`);
        continue;
      }
      if (!current) {
        if (start !== null) {
          error(lineNo, CODES.PARSE, 'multiple start diverts in preamble',
            'keep a single "-> phase" before the first phase header');
        } else {
          start = target;
        }
        continue;
      }
      if (current.divert) {
        error(lineNo, CODES.PARSE, `phase "${current.id}" already has a divert`,
          'a phase may have at most one fallthrough divert');
        continue;
      }
      current.divert = { target, line: lineNo } satisfies Divert;
      continue;
    }

    // Prose body
    if (!current) {
      error(lineNo, CODES.PARSE, `unexpected content before the first phase: "${line}"`,
        'the preamble may only contain VAR declarations, tags and a start divert');
      continue;
    }
    bodyLines.get(current.id)!.push(line);
  }

  for (const node of nodes) {
    node.body = (bodyLines.get(node.id) ?? []).join('\n');
  }

  if (start === null && nodes.length > 0) start = nodes[0].id;

  if (fence) {
    error(fence.line, CODES.PARSE, `unterminated """ block for metadata key "${fence.key}"`,
      'close the fenced value with a line containing only """');
  }

  return { variables, start, nodes, meta: planMeta, diagnostics };
}

function parseChoice(
  rest: string,
  node: TrajectoryNode,
  sticky: boolean,
  lineNo: number,
  error: (line: number, code: string, message: string, suggestion?: string) => void,
): Choice | null {
  let remaining = rest;

  const take = (re: RegExp): string | null => {
    const m = remaining.match(re);
    if (!m) return null;
    remaining = (remaining.slice(0, m.index!) + ' ' + remaining.slice(m.index! + m[0].length)).trim();
    return m[1] ?? m[0];
  };

  const gateSrc = take(/\{([^}]*)\}/);
  const label = take(/\[([^\]]*)\]/);
  const human = take(/@human\b/) !== null;
  const loop = take(/~loop~/) !== null;
  const target = take(/->\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);

  if (remaining.length > 0) {
    error(lineNo, CODES.PARSE, `unexpected content in choice: "${remaining}"`,
      'expected: * {gate} [Label] @human ~loop~ -> target (gate, @human and ~loop~ optional)');
    return null;
  }
  if (label === null || label.trim().length === 0) {
    error(lineNo, CODES.PARSE, 'choice requires a [label]',
      'every choice needs a human-legible label, e.g. * [Metrics green] -> beta_launch');
    return null;
  }
  if (target === null) {
    if (human) {
      error(lineNo, CODES.HUMAN_WITHOUT_ESCALATION,
        `human checkpoint "${label.trim()}" has no escalation path`,
        'every @human choice must divert somewhere: add "-> target" (or "-> END")');
    } else {
      error(lineNo, CODES.PARSE, `choice "${label.trim()}" has no divert`,
        'add "-> target" (or "-> END") at the end of the choice');
    }
    return null;
  }

  let gate: Choice['gate'] = null;
  if (gateSrc !== null && gateSrc.trim().length > 0) {
    try {
      gate = { source: gateSrc.trim(), ast: parseExpr(gateSrc) };
    } catch (e) {
      error(lineNo, CODES.PARSE, `invalid gate {${gateSrc.trim()}}: ${(e as Error).message}`);
      return null;
    }
  }

  return {
    id: `${node.id}#${node.choices.length}`,
    label: label.trim(),
    sticky,
    gate,
    human,
    loop,
    target,
    line: lineNo,
  };
}
