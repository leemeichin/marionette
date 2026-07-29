# The rule base: a plan as a database of facts

A compiled plan is a directed graph of state machines — which makes it a
database of facts, and makes the structural validators queries over that
database. This directory states them as such, and since
[ADR-0003](../../docs/decisions/0003-rules-as-spec.md) the statement is
**normative**: `marionette.pl` *is* the spec of the graph-layer semantics,
and since the 2026-07-28 cutover it is also the production graph and walker
engine. `src/validate.ts` and `src/state.ts` are asynchronous adapters around
its structured JSON predicates; acceptance vectors live in
[`spec/conformance/graph/`](../conformance/graph/). Each MAR code is a clause
that reads like its spec sentence:

```prolog
%% MAR006 — a phase with no effective exit is a dead end.
finding('MAR006', Line) :-
    node(N, Line, _), \+ eff_edge(N, _).
```

It serves two purposes:

1. **The production semantic engine.** `graph_findings_json/1` returns
   structured findings to the compiler. Pure explicit-state walker relations
   return frontiers, refusals and complete state transitions. The former
   TypeScript implementations remain under `tests/reference/` only during the
   30-day confidence window.
2. **A question surface.** Load a plan's facts into the toplevel and ask it
   things no CLI subcommand answers.

## Getting a fact base

```console
$ marionette facts plan.mar > plan.pl        # or: -o plan.pl
```

Schema (all terms ground; `Expr` mirrors the `Expr` AST in `src/types.ts`):

```prolog
plan_start(Node).                    % start node id
node(Node, Line, Ord).               % Ord: source order
variable(Name, Type, Initial, Line). % Initial: num(N)|bool(B)|str(S)|late_bound
action(Node, Var, Op, Expr, Line).   % Op: assign|inc|dec — applied on node entry
observation(Node, Var, Line).        % explicit `? Var` refresh checkpoint
choice(Id, Node, Target, Line, Ord). % Ord: global source order across the plan
label(Id, Label).                    % the human-legible claim on the choice
sticky(Id).                          % "+" repeatable (absent → "*" once-only)
human(Id).                           % @human checkpoint
loop_marked(Id).                     % ~loop~ declared cycle edge
gate(Id, Expr, Source).              % {gate} as AST + original text
next_step(Node, Target, Line).       % automatic next step
timebox(Node, Seconds).              % valid # timebox: (speculative phases)
timeout_choice(Id, Seconds, Source). % syntactic timeout edge
priority(Node, Level).               % valid # priority: critical|high|normal|low
```

`Expr` terms: `lit(num(N))`, `lit(bool(B))`, `lit(str(S))`, `var(Name)`,
`un(not|neg, E)`, `bin(Op, L, R)` with `Op` one of `or and eq ne lt le gt ge
add sub mul div mod`.

## Running the oracle

```console
$ marionette oracle plan.mar          # bundled wasm engine, no setup
MAR006	line 19
STRAND	line 25	once-only choice on a cycle can strand a traversal
✗ plan.mar: 2 findings from the rule base
```

Exit 1 on error-class findings (MAR006/007/009/010 and undeclared cycles);
warnings and STRAND report but pass. With a native SWI-Prolog the same
report comes straight from the rule base:

```console
$ swipl -q -g report -t halt spec/rules/marionette.pl plan.pl
MAR006	19
STRAND	25
```

One finding per line, tab-separated. `MAR006`–`MAR017` carry the source line
and match `marionette validate` exactly. Two kinds go beyond it:

- `MAR008 <a->b->c>` — an undeclared cycle, stated in its semantic form:
  *every simple cycle in the effective graph must carry a `~loop~` edge*. The
  TypeScript validator approximates this with DFS back edges, so the two are
  diffed on presence, not per-cycle; a cycle the rules find that the DFS pass
  missed is a gap in the approximation, not a false positive.
- `STRAND <line>` — a once-only (`*`) choice anywhere on a cycle
  ([#8](https://github.com/leemeichin/marionette/issues/8) item 2): if the
  traversal comes back around, that exit is exhausted, and a runtime stranding
  is possible. Not (yet) a compiler diagnostic — often the once-only-ness is
  the point — so the oracle surfaces it for review instead of the compiler
  warning on it.

## Questioning a plan

One-shot, via the bundled engine:

```console
$ marionette query plan.mar 'human_gate(C, Phase, Label)'
C = "dogfood_gate#0", Label = "Phase 1 exit approved", Phase = "dogfood_gate"
$ marionette query plan.mar 'unattended_completion'
false.
```

Or interactively, with a native toplevel:

```console
$ swipl spec/rules/marionette.pl plan.pl
```

```prolog
% Can the agent finish this plan without a human ever deciding anything?
?- unattended_completion.

% Which phases can be entered *and* completed with no human on the path?
?- unattended_phase(P).

% Every human checkpoint, with the claim a human must sign off on:
?- human_gate(Choice, Phase, Label).

% What can "beta_launch" still lead to?
?- reaches(beta_launch, X).

% Which phases sit inside loops?
?- cyclic(P).

% Which gates can provably never open? (rhetorical — the compiler already
% told you, but now you can ask *why* interactively)
?- false_gate(C), gate(C, E, Src), gate_status(E, all, unsat).
```

The rule base also states **walker semantics** (§7 of `marionette.pl`) as
pure relations over explicit state:

```prolog
?- initial_state(0, S0).
?- available(S0, 0, C).
?- apply(choose("0", "agent", true), S0, 0, S1, Outcome).
?- apply(observe(remaining, num(3), true), S0, 0, S1, Outcome).
```

State is `state(Status, Current, Vars, Taken, Pending, PendingEntry,
ActivatedAtMs)`. Refused `apply/5` operations return the input state unchanged.
The JSON bridge used by TypeScript is `walk_init_json/2`,
`walk_frontier_json/3` and `walk_apply_json/4`.

The building blocks (`can_reach/2` reachability, `on_same_cycle/2`,
`gate_status/3`, `direction/3` monotonicity, `eval/3`) are all queryable, so
ad-hoc questions compose without touching TypeScript. If your Prolog is
rusty, start with the "How to read this file" preamble at the top of
`marionette.pl` — it covers the four constructs the rules lean on
(negation as failure, if-then-else, tabling, `findall`) and the fact
schema, and every section opens with prose stating what its clauses claim.

## Equivalence discipline

Conformance is judged on structured findings, frontier/refusal codes and
state transitions — never on message strings. All wording lives in
`src/diagnostics.ts` and the TypeScript adapter. Effective
edges exclude provably-false gates before dead-end / reachability / cycle
analysis; per-gate verdicts use global mutations while loop-exit verdicts
scope monotonicity to the cycle's SCC (with global agreement); MAR009/MAR010
report once per SCC at the first triggering `~loop~` choice in source order.
A semantic change lands clause → structured result → conformance vector →
presentation.

## Dependency posture

**The engine ships in the bundle.** Installing marionette resolves
everything: the rule base runs on `swipl-wasm` — SWI-Prolog compiled to
WebAssembly, an ordinary npm dependency (~13 MB installed) — loaded lazily
in-process by `src/rule-engine.ts`. The singleton bridge serializes
facts-load/query transactions, so global plan facts cannot bleed between
concurrent callers. `spec/rules/marionette.pl` remains the editable,
standalone source of truth; `npm run generate:rules` embeds an exact copy in
`src/rules-source.ts`, and `npm run check:rules` rejects drift. Engine startup
therefore performs no filesystem read, and the compiler/walker module graph
contains no `node:` imports. `marionette validate`, walker commands, `oracle`
and `query` still need no system package or per-platform binary.

Why wasm over the alternatives a Prolog deployment usually reaches for:

- a **system SWI-Prolog** breaks self-containment — an agent installing the
  npm package can't be asked to apt/brew anything first;
- a **`qsave_program` saved state** compiles the program *plus the runtime*
  into a native executable, but per platform — an npm bundle would need an
  x64/arm64 × linux/macos/windows matrix and the maintenance that follows;
- the **wasm build is that same compiled artifact, portable**: one binary
  blob used by Node and by the browser playground on the same semantics path.

A native `swipl` (≥ 9, for tabling) remains the nicest way to use the
interactive toplevel — the `.pl` files are plain Prolog and load unchanged —
but nothing requires it: the bundled engine is the one the CLI, the tests
and CI all use, so agreement is enforced on every push with no setup at all.
