/**
 * Core types for Marionette: the trajectory contract (compiled JSON),
 * diagnostics, and expression ASTs shared by the parser, validators and runtime.
 */

export type Value = number | boolean | string;
export type VarType = 'number' | 'boolean' | 'string';

/** Expression AST used in gates, mutations and variable initialisers. */
export type Expr =
  | { kind: 'lit'; value: Value }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '!' | '-'; operand: Expr }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr };

export type BinOp =
  | '||' | '&&'
  | '==' | '!='
  | '<' | '<=' | '>' | '>='
  | '+' | '-' | '*' | '/' | '%';

export type MutationOp = '=' | '+=' | '-=';

export interface VariableDecl {
  type: VarType;
  initial: Value;
  line: number;
}

export interface Gate {
  /** Original source text of the gate, for legibility and rendering. */
  source: string;
  ast: Expr;
}

export interface Action {
  var: string;
  op: MutationOp;
  value: Expr;
  source: string;
  line: number;
}

export interface Choice {
  /** Stable id: `<nodeId>#<index>`. */
  id: string;
  label: string;
  /** `+` choices are repeatable; `*` choices may be taken once. */
  sticky: boolean;
  gate: Gate | null;
  /** Human checkpoint: the agent must pause and escalate; it may not take this choice autonomously. */
  human: boolean;
  /** Declared loop edge (`~loop~`): the author asserts this edge intentionally revisits earlier work. */
  loop: boolean;
  /** Target node id, or "END". */
  target: string;
  line: number;
}

export interface Divert {
  target: string;
  line: number;
}

export interface TrajectoryNode {
  id: string;
  /** Prose description of the phase. */
  body: string;
  /** Mutations applied when the node is entered. */
  actions: Action[];
  choices: Choice[];
  /** Unconditional fallthrough divert (taken when no choice is available/taken). */
  divert: Divert | null;
  line: number;
  /** Namespaced extension metadata from `# key: value` tag lines (e.g. `github:issue`). */
  meta: Record<string, string | string[]>;
}

/** The compiled contract between authoring (Phase 1) and agent ingestion (Phase 2). */
export interface Trajectory {
  /** Spec version of this document shape. */
  spec: string;
  /**
   * sha256 over the canonical form of this document (sorted keys, no whitespace,
   * `hash` field excluded). State files bind to this value to detect drift.
   */
  hash: string;
  source: { file: string };
  variables: Record<string, VariableDecl>;
  start: string;
  nodes: TrajectoryNode[];
  /** Plan-level namespaced extension metadata. */
  meta: Record<string, string | string[]>;
}

export const SPEC_VERSION = '0.1.0';
export const END = 'END';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine code, e.g. MAR006. */
  code: string;
  message: string;
  line?: number;
  suggestion?: string;
}

/** Diagnostic codes — one per defect class (P0.3/P0.4). */
export const CODES = {
  PARSE: 'MAR001',
  DUPLICATE_PHASE: 'MAR002',
  UNDEFINED_TARGET: 'MAR003',
  UNDEFINED_VARIABLE: 'MAR004',
  DUPLICATE_VARIABLE: 'MAR005',
  DEAD_END: 'MAR006',
  UNREACHABLE: 'MAR007',
  UNDECLARED_CYCLE: 'MAR008',
  LOOP_WITHOUT_EXIT: 'MAR009',
  LOOP_EXIT_UNSATISFIABLE: 'MAR010',
  CONSTANT_FALSE_GATE: 'MAR011',
  HUMAN_WITHOUT_ESCALATION: 'MAR012',
  LOOP_NOT_A_CYCLE: 'MAR013',
  UNVERIFIED_GATE: 'MAR014',
  TYPE_MISMATCH: 'MAR015',
  UNUSED_VARIABLE: 'MAR016',
  LOOP_ONCE_ONLY: 'MAR017',
} as const;

/** Decision log entry (G4: every taken branch records actor, timestamp, rationale). */
export interface LogEntry {
  at: string;
  actor: string;
  from: string | null;
  choice: string | null;
  label: string | null;
  to: string;
  rationale: string | null;
}

/** plan.state.json — traversal state bound to a compiled trajectory by content hash. */
export interface PlanState {
  /** Hash of the trajectory this state was recorded against. */
  hash: string;
  status: 'active' | 'completed';
  current: string;
  variables: Record<string, Value>;
  /** Ids of once-only (`*`) choices already taken. */
  taken: string[];
  log: LogEntry[];
}
