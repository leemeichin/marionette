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
  /**
   * A literal starts with a durable value. `null` is a late-bound `?`
   * initializer: the runtime must observe a value before traversal can begin.
   */
  initial: Value | null;
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

/** A runtime observation checkpoint (`? name`) reached at the end of a phase. */
export interface Observation {
  var: string;
  line: number;
}

/** A syntactic timeout edge (`timeout 3d -> fallback`). */
export interface Timeout {
  /** Original duration spelling, for rendering. */
  source: string;
  /** Normalised duration. */
  seconds: number;
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
  /**
   * Elicitation checkpoint: the agent may identify this route, but must ask a
   * human for missing context before the edge can advance.
   */
  ask: boolean;
  /** Declared loop edge (`~loop~`): the author asserts this edge intentionally revisits earlier work. */
  loop: boolean;
  /** Temporal availability for a `timeout` edge; null for ordinary choices. */
  timeout: Timeout | null;
  /** Target node id, or "END". */
  target: string;
  line: number;
}

export interface NextStep {
  target: string;
  line: number;
}

/**
 * A structured external reference (issue tracker, PR, document) normalised
 * from namespaced metadata tags, so consumers never re-parse meta conventions.
 */
export interface Ref {
  /** Source system: "github", "jira", "linear", "url", … (open set). */
  provider: string;
  /** What is referenced: "issue", "pr", "repo", "link", … (open set). */
  kind: string;
  /** Canonical identifier, e.g. "acme/platform#12", "PROJ-123", or a URL. */
  id: string;
  /** Browsable URL when derivable from the available context, else null. */
  url: string | null;
}

export interface TrajectoryNode {
  id: string;
  /** Prose description of the phase. */
  body: string;
  /** Mutations applied when the node is entered. */
  actions: Action[];
  /** Values the executor must refresh after doing this phase's work. */
  observations: Observation[];
  choices: Choice[];
  /** Automatic route taken when the phase is complete. */
  next: NextStep | null;
  line: number;
  /** Namespaced extension metadata from `# key: value` tag lines (e.g. `github:issue`). */
  meta: Record<string, string | string[]>;
  /** External references normalised from this node's metadata. */
  refs: Ref[];
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
  /** External references normalised from the plan-level metadata. */
  refs: Ref[];
}

export const SPEC_VERSION = '0.5.0';
export const PLAN_STATE_VERSION = 2;
export const END = 'END';

export type Severity = 'error' | 'warning';

/**
 * A semantic validator finding: what is wrong and where, as pure data.
 * The presentation layer (diagnostics.ts renderFinding) phrases it; the rule
 * base (spec/rules/marionette.pl) states the same fact as a clause. Semantic
 * implementations are compared on Findings, never on message strings.
 */
export interface Finding {
  code: string;
  severity: Severity;
  line?: number;
  /** Message-shape discriminator for codes with several defect shapes. */
  variant?: string;
  /** Structured slots the presentation layer phrases from. */
  data: Record<string, string | number | string[] | null>;
}

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
  MALFORMED_REF: 'MAR018',
  UNKNOWN_DELIVERY: 'MAR019',
  UNKNOWN_TRACKER: 'MAR020',
  MALFORMED_TIMEBOX: 'MAR021',
  UNKNOWN_PRIORITY: 'MAR022',
  TIMEBOX_WITHOUT_ALTERNATIVE: 'MAR023',
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

/** Audited externally supplied value, separate from branch decisions. */
export interface ObservationEntry {
  at: string;
  actor: string;
  node: string | null;
  variable: string;
  value: Value;
  rationale: string | null;
}

/** One open or answered `@ask` exchange in the traversal audit trail. */
export interface ElicitationEntry {
  choice: string;
  label: string;
  target: string;
  question: string;
  askedAt: string;
  askedBy: string;
  rationale: string | null;
  answer: string | null;
  answeredAt: string | null;
  answeredBy: string | null;
}

/** The `@ask` edge currently waiting for a human answer. */
export interface PendingElicitation {
  choice: string;
  target: string;
  question: string;
  askedAt: string;
  askedBy: string;
  rationale: string | null;
}

/** plan.state.json — traversal state bound to a compiled trajectory by content hash. */
export interface PlanState {
  /** Persistence contract version. Version 1 states are intentionally rejected. */
  version: typeof PLAN_STATE_VERSION;
  /** Hash of the trajectory this state was recorded against. */
  hash: string;
  status: 'active' | 'completed';
  current: string;
  variables: Record<string, Value>;
  /** Late-bound or explicitly refreshed values that must be supplied. */
  pendingObservations: string[];
  /** Late-bound initializers suspend start-node entry actions until resolved. */
  pendingEntry: boolean;
  /** Start of the current activation. Direct self-loops preserve this timestamp. */
  activationStartedAt: string | null;
  /** Runtime observations are auditable without pretending they are graph transitions. */
  observations: ObservationEntry[];
  /** Open-ended clarification currently blocking traversal. */
  pendingElicitation: PendingElicitation | null;
  /** Asked and answered clarifications, kept separately from branch decisions. */
  elicitations: ElicitationEntry[];
  /** Ids of once-only (`*`) choices already taken. */
  taken: string[];
  log: LogEntry[];
}
