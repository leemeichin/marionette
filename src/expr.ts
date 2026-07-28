/**
 * Expression language for gates (`{iteration < 3}`), mutations (`~ x += 1`)
 * and variable initialisers. A small Pratt parser over a hand-rolled tokenizer.
 */

import type { BinOp, Expr, Value, VarType } from './types.ts';

export class ExprError extends Error {
  constructor(message: string, public readonly pos?: number) {
    super(message);
    this.name = 'ExprError';
  }
}

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'str'; value: string; pos: number }
  | { kind: 'bool'; value: boolean; pos: number }
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

const OPERATORS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '!', '+', '-', '*', '/', '%', '(', ')'];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  outer: while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && /[0-9._]/.test(src[i])) i++;
      const raw = src.slice(start, i).replace(/_/g, '');
      const value = Number(raw);
      if (Number.isNaN(value)) throw new ExprError(`invalid number "${raw}"`, start);
      tokens.push({ kind: 'num', value, pos: start });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let out = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
        out += src[i];
        i++;
      }
      if (i >= src.length) throw new ExprError('unterminated string literal', start);
      i++;
      tokens.push({ kind: 'str', value: out, pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      const word = src.slice(start, i);
      if (word === 'true' || word === 'false') {
        tokens.push({ kind: 'bool', value: word === 'true', pos: start });
      } else if (word === 'and') {
        tokens.push({ kind: 'op', value: '&&', pos: start });
      } else if (word === 'or') {
        tokens.push({ kind: 'op', value: '||', pos: start });
      } else if (word === 'not') {
        tokens.push({ kind: 'op', value: '!', pos: start });
      } else {
        tokens.push({ kind: 'ident', value: word, pos: start });
      }
      continue;
    }
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        tokens.push({ kind: 'op', value: op, pos: i });
        i += op.length;
        continue outer;
      }
    }
    throw new ExprError(`unexpected character "${ch}"`, i);
  }
  tokens.push({ kind: 'eof', pos: src.length });
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }

  parseExpression(minPrec = 0): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== 'op') break;
      const prec = BINARY_PRECEDENCE[tok.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseExpression(prec + 1);
      left = { kind: 'binary', op: tok.value as BinOp, left, right };
    }
    return left;
  }

  private parsePrefix(): Expr {
    const tok = this.next();
    switch (tok.kind) {
      case 'num': return { kind: 'lit', value: tok.value };
      case 'str': return { kind: 'lit', value: tok.value };
      case 'bool': return { kind: 'lit', value: tok.value };
      case 'ident': return { kind: 'var', name: tok.value };
      case 'op':
        if (tok.value === '(') {
          const inner = this.parseExpression(0);
          const close = this.next();
          if (close.kind !== 'op' || close.value !== ')') {
            throw new ExprError('expected ")"', close.pos);
          }
          return inner;
        }
        if (tok.value === '!' || tok.value === '-') {
          return { kind: 'unary', op: tok.value, operand: this.parsePrefix() };
        }
        throw new ExprError(`unexpected operator "${tok.value}"`, tok.pos);
      case 'eof':
        throw new ExprError('unexpected end of expression', tok.pos);
    }
  }

  expectEof(): void {
    const tok = this.peek();
    if (tok.kind !== 'eof') {
      const shown = tok.kind === 'op' ? tok.value : String((tok as { value: Value }).value);
      throw new ExprError(`unexpected trailing input "${shown}"`, tok.pos);
    }
  }
}

export function parseExpr(src: string): Expr {
  const parser = new Parser(tokenize(src));
  const expr = parser.parseExpression(0);
  parser.expectEof();
  return expr;
}

export function typeOf(value: Value): VarType {
  return typeof value as VarType;
}

/** Evaluate an expression against a variable environment. Throws ExprError on type errors. */
export function evalExpr(expr: Expr, env: Record<string, Value>): Value {
  switch (expr.kind) {
    case 'lit':
      return expr.value;
    case 'var': {
      if (!(expr.name in env)) throw new ExprError(`undefined variable "${expr.name}"`);
      return env[expr.name];
    }
    case 'unary': {
      const v = evalExpr(expr.operand, env);
      if (expr.op === '!') {
        if (typeof v !== 'boolean') throw new ExprError(`"!" expects a boolean, got ${typeOf(v)}`);
        return !v;
      }
      if (typeof v !== 'number') throw new ExprError(`unary "-" expects a number, got ${typeOf(v)}`);
      return -v;
    }
    case 'binary': {
      const { op } = expr;
      if (op === '&&' || op === '||') {
        const l = evalExpr(expr.left, env);
        if (typeof l !== 'boolean') throw new ExprError(`"${op}" expects booleans, got ${typeOf(l)}`);
        if (op === '&&' && !l) return false;
        if (op === '||' && l) return true;
        const r = evalExpr(expr.right, env);
        if (typeof r !== 'boolean') throw new ExprError(`"${op}" expects booleans, got ${typeOf(r)}`);
        return r;
      }
      const l = evalExpr(expr.left, env);
      const r = evalExpr(expr.right, env);
      if (op === '==' || op === '!=') {
        if (typeOf(l) !== typeOf(r)) {
          throw new ExprError(`cannot compare ${typeOf(l)} with ${typeOf(r)}`);
        }
        return op === '==' ? l === r : l !== r;
      }
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new ExprError(`"${op}" expects numbers, got ${typeOf(l)} and ${typeOf(r)}`);
        }
        switch (op) {
          case '<': return l < r;
          case '<=': return l <= r;
          case '>': return l > r;
          case '>=': return l >= r;
        }
      }
      // Arithmetic; '+' also concatenates strings.
      if (op === '+' && typeof l === 'string' && typeof r === 'string') return l + r;
      if (typeof l !== 'number' || typeof r !== 'number') {
        throw new ExprError(`"${op}" expects numbers, got ${typeOf(l)} and ${typeOf(r)}`);
      }
      switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
      }
    }
  }
}

/** Collect all variable names referenced by an expression. */
export function varsIn(expr: Expr, into: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'lit': break;
    case 'var': into.add(expr.name); break;
    case 'unary': varsIn(expr.operand, into); break;
    case 'binary': varsIn(expr.left, into); varsIn(expr.right, into); break;
  }
  return into;
}

/** Evaluate a constant (variable-free) expression, or return undefined if it references variables. */
export function tryConstEval(expr: Expr): Value | undefined {
  if (varsIn(expr).size > 0) return undefined;
  try {
    return evalExpr(expr, {});
  } catch {
    return undefined;
  }
}
