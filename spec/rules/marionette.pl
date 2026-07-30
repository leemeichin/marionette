:- encoding(utf8).
/*  Marionette graph semantics — NORMATIVE (ADR-0003).
 *
 *  A compiled plan is a database of facts; this file is the specification
 *  and production engine for Marionette's graph diagnostics and walker.
 *  Each MAR code reads as a claim about the graph; walker relations are
 *  pure transformations of explicit state. An implementation conforms iff
 *  it reproduces the structured findings and state transitions frozen in
 *  spec/conformance/. Wording, suggestions, audit persistence and exit
 *  codes are TypeScript presentation/driver concerns, out of scope here.
 *
 *  ── How to read this file (assuming basic Prolog) ──────────────────────
 *
 *  · Lower-case terms are atoms (constants); Capitalised terms are
 *    variables. `foo(N, Line)` succeeds for every N/Line the database and
 *    rules can justify — order of clauses is alternatives ("or"), a comma
 *    is "and".
 *  · `\+ Goal` is negation as failure: "Goal cannot be proven". It is how
 *    every "has no …" claim below is written.
 *  · `( Cond -> Then ; Else )` is if-then-else. `!` (cut) commits to the
 *    current choice — used sparingly here, only to make a check
 *    deterministic.
 *  · `:- table foo/2.` memoizes foo/2. We table the reachability
 *    predicates so recursive graph walks terminate on cycles (this is what
 *    makes "A can reach B" safe to state naively).
 *  · `findall(X, Goal, Xs)` collects every solution of Goal into a list.
 *
 *  The fact base (emitted by `marionette facts plan.mar`, full schema in
 *  README.md alongside this file):
 *
 *    plan_start(Node)                     the start phase
 *    node(Node, Line, Ord)                a phase, its source line + order
 *    variable(Name, Type, Init, Line)     VAR declaration (Init may be late_bound)
 *    action(Node, Var, Op, Expr, Line)    ~ mutation on entry (assign|inc|dec)
 *    observation(Node, Var, Line)         ? runtime refresh checkpoint
 *    choice(Id, Node, Target, Line, Ord)  an exit edge; Ord is global order
 *    label(Id, Text)                      the choice's human-readable claim
 *    sticky(Id)                           "+" repeatable ("*" when absent)
 *    human(Id)                            @human checkpoint
 *    ask(Id)                              interaction requiring trusted input (spec-specific)
 *    loop_marked(Id)                      ~loop~ declared cycle edge
 *    gate(Id, Expr, Source)               {gate} as an AST + original text
 *    next_step(Node, Target, Line)        automatic next step
 *    timebox(Node, Seconds)               # timebox: (speculative phases)
 *    timeout_choice(Id, Seconds, Source)  syntactic timeout edge
 *    priority(Node, Level)                # priority:
 *
 *  Expressions are ground terms: lit(num(3)), lit(bool(true)),
 *  lit(str("x")), var(name), un(not|neg, E), bin(Op, L, R) with Op one of
 *  or and eq ne lt le gt ge add sub mul div mod.
 *
 *  Usage:
 *    marionette oracle plan.mar                 (bundled engine)
 *    marionette query plan.mar 'cyclic(P)'      (one-shot question)
 *    swipl -q -g report -t halt spec/rules/marionette.pl plan.pl
 *    swipl spec/rules/marionette.pl plan.pl     (interactive toplevel)
 *
 *  Report protocol (one finding per line, tab-separated):
 *    MAR006..MAR023 <line>    exact-match diagnostics
 *    MAR008 <a->b->a>         an effective simple cycle with no ~loop~ edge
 *    STRAND <line>            once-only choice on a cycle (issue #8 item 2)
 */

% Facts arrive from a separate file (or load_string), so declare them
% dynamic — and discontiguous, since the emitter groups them per phase.
:- dynamic plan_start/1, node/3, variable/4, action/5, observation/3, choice/5,
           label/2, sticky/1, human/1, ask/1, loop_marked/1, gate/3, next_step/3,
           timebox/2, timeout_choice/3, priority/2.
:- discontiguous finding/2.

end_id('END').

/* ═════════════════════ 1 · Expression evaluation ═══════════════════════
 *
 * Mirrors src/expr.ts evalExpr. Values are typed terms — num(N), bool(B),
 * str(S) — and a type error simply fails the goal (the TS evaluator
 * throws; both mean "no verdict"). Env is a list of Name-Value pairs.
 */

bool_not(true, false).
bool_not(false, true).

eval(lit(V), _, V).
eval(var(N), Env, V) :- memberchk(N-V, Env).
eval(un(not, E), Env, bool(R)) :- eval(E, Env, bool(B)), bool_not(B, R).
eval(un(neg, E), Env, num(R)) :- eval(E, Env, num(N)), R is -N.
% and/or short-circuit exactly like the TS evaluator.
eval(bin(and, L, R), Env, bool(V)) :-
    eval(L, Env, bool(BL)),
    ( BL == false -> V = false ; eval(R, Env, bool(V)) ).
eval(bin(or, L, R), Env, bool(V)) :-
    eval(L, Env, bool(BL)),
    ( BL == true -> V = true ; eval(R, Env, bool(V)) ).
% ==/!= compare only same-typed values; numbers by value (1 equals 1.0).
eval(bin(eq, L, R), Env, bool(V)) :-
    eval(L, Env, VL), eval(R, Env, VR), eq_val(VL, VR, V).
eval(bin(ne, L, R), Env, bool(V)) :-
    eval(L, Env, VL), eval(R, Env, VR), eq_val(VL, VR, E), bool_not(E, V).
eval(bin(Op, L, R), Env, bool(V)) :-
    num_cmp(Op),
    eval(L, Env, num(A)), eval(R, Env, num(B)),
    ( cmp_holds(Op, A, B) -> V = true ; V = false ).
% + adds numbers or concatenates strings, as in the DSL.
eval(bin(add, L, R), Env, V) :-
    eval(L, Env, VL), eval(R, Env, VR),
    (  VL = str(A), VR = str(B) -> string_concat(A, B, S), V = str(S)
    ;  VL = num(A), VR = num(B) -> N is A + B, V = num(N)
    ).
eval(bin(sub, L, R), Env, num(V)) :- eval(L, Env, num(A)), eval(R, Env, num(B)), V is A - B.
eval(bin(mul, L, R), Env, num(V)) :- eval(L, Env, num(A)), eval(R, Env, num(B)), V is A * B.
eval(bin(div, L, R), Env, num(V)) :- eval(L, Env, num(A)), eval(R, Env, num(B)), B =\= 0, V is A / B.
% JS-style remainder: the sign follows the dividend.
eval(bin(mod, L, R), Env, num(V)) :-
    eval(L, Env, num(A)), eval(R, Env, num(B)), B =\= 0, V is A - B * truncate(A / B).

eq_val(num(A),  num(B),  V) :- ( A =:= B -> V = true ; V = false ).
eq_val(bool(A), bool(B), V) :- ( A == B  -> V = true ; V = false ).
eq_val(str(A),  str(B),  V) :- ( A == B  -> V = true ; V = false ).

num_cmp(lt). num_cmp(le). num_cmp(gt). num_cmp(ge).
cmp_holds(lt, A, B) :- A < B.
cmp_holds(le, A, B) :- A =< B.
cmp_holds(gt, A, B) :- A > B.
cmp_holds(ge, A, B) :- A >= B.

% Which variables appear in an expression, and constant folding.
expr_var(var(N), N).
expr_var(un(_, E), N) :- expr_var(E, N).
expr_var(bin(_, L, R), N) :- ( expr_var(L, N) ; expr_var(R, N) ).
has_vars(E) :- expr_var(E, _), !.

const_eval(E, V) :- \+ has_vars(E), once(eval(E, [], V)).

% Evaluate against declared initial values (used when nothing ever
% mutates the variables an expression mentions).
eval_with_initials(E, V) :-
    setof(N-I, T^L^(expr_var(E, N), variable(N, T, I, L), I \== late_bound), Env),
    once(eval(E, Env, V)).

/* ═════════════════════ 2 · Gate analysis ═══════════════════════════════
 *
 * The compiler only ever claims a verdict when it is provable; everything
 * else is `unknown` and surfaces as MAR014. The former TypeScript mirror is
 * quarantined at tests/reference/gates.ts for cutover differential tests.
 *
 * A Scope is either `all` (every mutation in the plan) or nodes(Ms)
 * (mutations inside one cycle's phases). Loop-exit verdicts use the cycle
 * scope so a counter mutated only inside the loop still counts — but the
 * global direction must agree, so a reset elsewhere voids the claim.
 */

mutated(Var) :- action(_, Var, _, _, _), !.

scope_action(all, Var, Op, ValExpr) :- action(_, Var, Op, ValExpr, _).
scope_action(nodes(Ms), Var, Op, ValExpr) :- member(M, Ms), action(M, Var, Op, ValExpr, _).

% Each mutation moves a variable up (pos), down (neg), or unpredictably.
action_delta(assign, _, unknown).
action_delta(inc, ValExpr, D) :- step_sign(ValExpr,  1, D).
action_delta(dec, ValExpr, D) :- step_sign(ValExpr, -1, D).
step_sign(ValExpr, Mul, D) :-
    (  const_eval(ValExpr, num(S)), S =\= 0
    -> ( S * Mul > 0 -> D = pos ; D = neg )
    ;  D = unknown ).

%% direction(+Var, +Scope, -Dir): a variable is a monotonic counter when
%% every mutation in scope moves it the same way. Dir is inc | dec | none
%% (never mutated) | unknown.
direction(Var, Scope, Dir) :-
    findall(D, ( scope_action(Scope, Var, Op, V), action_delta(Op, V, D) ), Ds),
    (  Ds == [] -> Dir = none
    ;  memberchk(unknown, Ds) -> Dir = unknown
    ;  sort(Ds, Sorted),
       ( Sorted == [pos] -> Dir = inc ; Sorted == [neg] -> Dir = dec ; Dir = unknown )
    ).

%% counter_cmp(+Expr, -Var, -Op, -Const): recognise `v OP k` / `k OP v`
%% (the op is flipped when the constant is on the left).
counter_cmp(bin(Op, var(X), C), X, Op, K) :- cmp_like(Op), const_eval(C, num(K)).
counter_cmp(bin(Op, C, var(X)), X, F, K)  :- cmp_like(Op), const_eval(C, num(K)), flip(Op, F).
cmp_like(lt). cmp_like(le). cmp_like(gt). cmp_like(ge). cmp_like(eq). cmp_like(ne).
flip(lt, gt). flip(le, ge). flip(gt, lt). flip(ge, le). flip(eq, eq). flip(ne, ne).

%% gate_status(+Expr, +Scope, -Status): sat | unsat | unknown.
%% Three provable cases, tried in order; anything else is unknown:
%%   1. no variables            → fold the constant;
%%   2. variables never mutated → evaluate against declared initials;
%%   3. a monotonic counter compared toward its direction of travel
%%      → eventually true.
gate_status(E, Scope, Status) :-
    (  \+ has_vars(E)
    -> decide(const_eval(E, bool(true)), const_eval(E, bool(false)), Status)
    ;  forall(expr_var(E, V), (variable(V, _, I, _), I \== late_bound, \+ mutated(V)))
    -> decide(eval_with_initials(E, bool(true)), eval_with_initials(E, bool(false)), Status)
    ;  counter_eventually_true(E, Scope)
    -> Status = sat
    ;  E = un(not, Inner), eventually_false(Inner, Scope)
    -> Status = sat
    ;  Status = unknown
    ).

decide(TrueGoal, FalseGoal, Status) :-
    (  call(TrueGoal)  -> Status = sat
    ;  call(FalseGoal) -> Status = unsat
    ;  Status = unknown
    ).

counter_eventually_true(E, Scope) :-
    counter_cmp(E, X, Op, _),
    variable(X, number, _, _),
    direction(X, Scope, Dir), direction(X, all, Dir),
    (  Dir == inc -> memberchk(Op, [gt, ge, ne])
    ;  Dir == dec -> memberchk(Op, [lt, le, ne])
    ), !.

%% eventually_false(+Expr, +Scope): the dual claim, for loop-continue
%% gates — {i < 3} with i counting up must eventually shut, which is what
%% makes a loop provably bounded.
eventually_false(E, Scope) :-
    counter_cmp(E, X, Op, _),
    variable(X, number, _, _),
    direction(X, Scope, Dir), direction(X, all, Dir),
    (  Dir == inc -> memberchk(Op, [lt, le, eq])
    ;  Dir == dec -> memberchk(Op, [gt, ge, eq])
    ), !.

/* ═════════════════════ 3 · The graph ═══════════════════════════════════
 *
 * Two edge relations matter:
 *   effective — choices whose gate is not provably false, plus automatic
 *     next steps.
 *     Dead-end / reachability / cycle analysis all run on this graph,
 *     because a provably-false gate is an edge that never exists.
 *   unfiltered — every authored edge, used only by the per-gate MAR014
 *     exemption (a gate's cycle membership shouldn't depend on verdicts).
 */

false_gate(C) :- gate(C, E, _), gate_status(E, all, unsat).

eff_choice_edge(C, F, T) :- choice(C, F, T, _, _), \+ false_gate(C).
eff_edge(F, T) :- eff_choice_edge(_, F, T).
eff_edge(F, T) :- next_step(F, T, _).

% One step between declared phases. END terminates every path, so it is
% never an intermediate node.
eff_step(F, T) :- eff_edge(F, T), \+ end_id(T), node(T, _, _).
any_step(F, T) :- choice(_, F, T, _, _), \+ end_id(T), node(T, _, _).
any_step(F, T) :- next_step(F, T, _), \+ end_id(T), node(T, _, _).

%% can_reach(?A, ?B): a path of one or more effective steps. Tabled so the
%% recursion terminates on cyclic graphs.
:- table can_reach/2.
can_reach(A, B) :- eff_step(A, B).
can_reach(A, B) :- eff_step(A, M), can_reach(M, B).

:- table can_reach_any/2.
can_reach_any(A, B) :- any_step(A, B).
can_reach_any(A, B) :- any_step(A, M), can_reach_any(M, B).

%% on_cycle_with(+F, +T): F and T sit on a common cycle of the
%% *unfiltered* graph (or the edge is a self-loop). Used only for the
%% MAR014 loop-continue exemption.
on_cycle_with(F, T) :- F == T, !.
on_cycle_with(F, T) :- \+ end_id(T), can_reach_any(F, T), can_reach_any(T, F).

%% on_same_cycle(+A, +B): A and B lie on a common *effective* cycle —
%% mutually reachable, or A == B with a path back to itself.
on_same_cycle(A, B) :- ( A == B -> can_reach(A, A) ; can_reach(A, B), can_reach(B, A) ).

%% cycle_member(+N, -M): the phases of N's cycle (N itself included).
%% Backtracking over M enumerates the whole strongly-connected component.
cycle_member(N, N).
cycle_member(N, M) :- can_reach(N, M), can_reach(M, N), M \== N.

/* ═════════════════════ 4 · Diagnostics ═════════════════════════════════
 *
 * finding(Code, Line) — each clause below is the normative statement of
 * one MAR code.
 */

%% MAR006 — a phase with no effective exit is a dead end.
finding('MAR006', Line) :-
    node(N, Line, _), \+ eff_edge(N, _).

%% MAR007 — a phase (other than the start) the start cannot reach.
finding('MAR007', Line) :-
    plan_start(S),
    node(N, Line, _), N \== S, \+ can_reach(S, N).

%% MAR011 — a gate that provably never opens.
finding('MAR011', Line) :-
    choice(C, _, _, Line, _), false_gate(C).

%% MAR013 — a ~loop~ mark on an edge that closes no cycle.
finding('MAR013', Line) :-
    loop_marked(C), \+ false_gate(C),
    choice(C, N, T, Line, _), \+ closes_cycle(N, T).

closes_cycle(N, T) :- \+ end_id(T), on_same_cycle(N, T).

%% MAR017 — a once-only ("*") ~loop~ edge can iterate at most once.
finding('MAR017', Line) :-
    loop_marked(C), \+ false_gate(C), \+ sticky(C),
    choice(C, _, _, Line, _).

%% MAR023 — a timeboxed phase with a single exit: spending or not spending
%% the budget leads to the same place, so the timebox decides nothing.
finding('MAR023', Line) :-
    timebox(N, _), node(N, Line, _),
    findall(x, choice(_, N, _, _, _), Cs), length(Cs, Choices),
    ( next_step(N, _, _) -> NextSteps = 1 ; NextSteps = 0 ),
    Exits is Choices + NextSteps,
    Exits < 2.

/* ── Loop exits (MAR009 / MAR010 / loop-exit MAR014) ────────────────────
 *
 * One analysis per cycle, reported at its first (source-order) ~loop~
 * choice via the emitted ordinals. A cycle's exits are the edges leaving its member
 * set; their gates are judged with monotonicity scoped to the cycle.
 */

% A ~loop~ choice that actually closes a cycle starts an analysis…
trigger(C, N) :-
    loop_marked(C), \+ false_gate(C),
    choice(C, N, T, _, _), closes_cycle(N, T).

% …but only the first trigger of each cycle (by source order) reports.
primary_trigger(C, N) :-
    trigger(C, N), choice(C, _, _, _, Ord),
    \+ ( trigger(C2, N2), C2 \== C, on_same_cycle(N, N2),
         choice(C2, _, _, _, Ord2), Ord2 < Ord ).

cycle_scope(N, nodes(Ms)) :- setof(M, cycle_member(N, M), Ms).

%% exit_edge(+N, -Kind, -Line): effective edges leaving N's cycle
%% (to END or to a phase outside the member set).
exit_edge(N, choice(C), Line) :-
    cycle_member(N, M), eff_choice_edge(C, M, T), leaves(N, T),
    choice(C, _, _, Line, _).
exit_edge(N, next_step, Line) :-
    cycle_member(N, M), next_step(M, T, Line), leaves(N, T).

leaves(_, T) :- end_id(T), !.
leaves(N, T) :- \+ cycle_member(N, T).

% An automatic next step or ungated choice is a sure exit; a gated one needs a
% satisfiable verdict (with cycle-scoped monotonicity).
exit_sat(_, next_step).
exit_sat(Scope, choice(C)) :-
    ( gate(C, E, _) -> gate_status(E, Scope, sat) ; true ).

exit_unsat(Scope, choice(C)) :- gate(C, E, _), gate_status(E, Scope, unsat).

%% MAR009 — a cycle with no exit path at all.
%% MAR010 — a cycle whose every exit gate is provably unsatisfiable.
finding(Code, Line) :-
    primary_trigger(C, N), choice(C, _, _, Line, _),
    loop_verdict(N, Code).

loop_verdict(N, Code) :-
    (  \+ exit_edge(N, _, _)
    -> % No exits at all — but if a false gate *removed* the only exit,
       % that is MAR010 (unsatisfiable), not MAR009 (never authored).
       ( false_gated_exit(N) -> Code = 'MAR010' ; Code = 'MAR009' )
    ;  cycle_scope(N, Scope),
       \+ ( exit_edge(N, Kind, _), exit_sat(Scope, Kind) ),
       forall(exit_edge(N, Kind, _), exit_unsat(Scope, Kind)),
       Code = 'MAR010'
    ).

false_gated_exit(N) :-
    cycle_member(N, M), choice(C, M, T, _, _), false_gate(C),
    ( end_id(T) ; \+ cycle_member(N, T) ), !.

%% Loop exits that are neither provable nor refutable → MAR014, reported
%% on each undecidable exit edge (only when no exit is provably open).
loop_unverified_exit(C2, Line) :-
    primary_trigger(_, N),
    cycle_scope(N, Scope),
    \+ ( exit_edge(N, Kind, _), exit_sat(Scope, Kind) ),
    exit_edge(N, choice(C2), Line),
    gate(C2, E, _), gate_status(E, Scope, unknown).

%% MAR014 — gates the analysis cannot decide: loop exits first, then every
%% other unknown gate — except a loop-continue gate that provably shuts
%% (that is a verified bounded loop, not a warning).
finding('MAR014', Line) :- loop_unverified_exit(_, Line).
finding('MAR014', Line) :-
    choice(C, N, T, Line, _), gate(C, E, _),
    gate_status(E, all, unknown),
    \+ bounded_loop_gate(C, N, T, E),
    \+ loop_unverified_exit(C, _).

bounded_loop_gate(C, N, T, E) :-
    ( loop_marked(C) ; on_cycle_with(N, T) ),
    eventually_false(E, all).

/* ── MAR008: undeclared cycles, in semantic form ────────────────────────
 *
 * The law stated directly: every simple cycle in the effective graph must
 * carry at least one ~loop~-marked choice edge. (The reference
 * implementation approximates this with DFS back edges, so the harness
 * compares MAR008 on presence, not per-cycle — see the README.)
 */

cycle_edge(F, T, choice(C)) :- eff_choice_edge(C, F, T), \+ end_id(T), node(T, _, _).
cycle_edge(F, T, next_step) :- next_step(F, T, _), \+ end_id(T), node(T, _, _).

%% undeclared_cycle(-Nodes): a simple cycle none of whose edges is marked.
%% Each cycle is reported once, from its alphabetically-first phase.
undeclared_cycle(Nodes) :-
    node(Origin, _, _),
    simple_cycle(Origin, Nodes, Edges),
    \+ ( member(choice(C), Edges), loop_marked(C) ),
    msort(Nodes, [Origin|_]).

% Walk from Origin back to Origin without revisiting a phase. Seen is the
% visited list; the clause heads keep nodes and edges in step.
simple_cycle(Origin, [Origin|Ns], [E|Es]) :-
    cycle_edge(Origin, Next, E),
    grow_cycle(Next, Origin, [Origin], Ns, Es).
grow_cycle(Origin, Origin, _, [], []) :- !.        % closed the cycle
grow_cycle(Cur, Origin, Seen, [Cur|Ns], [E|Es]) :-
    Cur \== Origin, \+ memberchk(Cur, Seen),
    cycle_edge(Cur, Next, E),
    grow_cycle(Next, Origin, [Cur|Seen], Ns, Es).

has_undeclared_cycle :- undeclared_cycle(_), !.

%% undeclared_cycle_detail(-ClosedPath, -Line): production diagnostic form.
%% The path repeats its origin at the end and is located on the closing edge.
undeclared_cycle_detail(ClosedPath, Line) :-
    undeclared_cycle(Nodes),
    Nodes = [Origin|_],
    last(Nodes, Last),
    setof(L, cycle_edge_line(Last, Origin, L), [Line|_]),
    append(Nodes, [Origin], ClosedPath).

cycle_edge_line(F, T, Line) :-
    eff_choice_edge(C, F, T), choice(C, _, _, Line, _).
cycle_edge_line(F, T, Line) :- next_step(F, T, Line).

/* ── STRAND: once-only choices on a cycle ───────────────────────────────
 *
 * Issue #8 item 2: an exhausted "*" exit anywhere inside a cycle can
 * strand a traversal when the loop comes back around. Not a compiler
 * diagnostic (once-only-ness is often the point) — the rule base surfaces
 * it for review.
 */

stranding(C, Line) :-
    choice(C, N, T, Line, _),
    \+ sticky(C), \+ false_gate(C),
    \+ end_id(T), on_same_cycle(N, T).

/* ── Structured production findings ─────────────────────────────────────
 *
 * finding/2 remains the compact conformance/query surface. graph_finding/4
 * carries the semantic identity needed by the TypeScript presentation layer
 * without making it infer a verdict from source objects.
 */

graph_finding('MAR006', error, Line, dead_end(N)) :-
    node(N, Line, _), \+ eff_edge(N, _).
graph_finding('MAR007', error, Line, unreachable(N, S)) :-
    plan_start(S), node(N, Line, _), N \== S, \+ can_reach(S, N).
graph_finding('MAR008', error, Line, undeclared_cycle(Path)) :-
    undeclared_cycle_detail(Path, Line).
graph_finding(Code, error, Line, loop_exit(N)) :-
    primary_trigger(C, N), choice(C, _, _, Line, _),
    loop_verdict(N, Code),
    memberchk(Code, ['MAR009', 'MAR010']).
graph_finding('MAR011', warning, Line, false_gate(C, Reason)) :-
    choice(C, _, _, Line, _), false_gate(C), false_gate_reason(C, Reason).
graph_finding('MAR013', warning, Line, loop_not_cycle(C)) :-
    loop_marked(C), \+ false_gate(C),
    choice(C, N, T, Line, _), \+ closes_cycle(N, T).
graph_finding('MAR014', warning, Line, unverified_gate(C, loop_exit)) :-
    loop_unverified_exit(C, Line).
graph_finding('MAR014', warning, Line, unverified_gate(C, choice)) :-
    choice(C, N, T, Line, _), gate(C, E, _),
    gate_status(E, all, unknown),
    \+ bounded_loop_gate(C, N, T, E),
    \+ loop_unverified_exit(C, _).
graph_finding('MAR017', warning, Line, loop_once(C)) :-
    loop_marked(C), \+ false_gate(C), \+ sticky(C),
    choice(C, _, _, Line, _).
graph_finding('MAR023', warning, Line, timebox_without_alternative(N)) :-
    timebox(N, _), node(N, Line, _),
    findall(x, choice(_, N, _, _, _), Cs), length(Cs, Choices),
    ( next_step(N, _, _) -> NextSteps = 1 ; NextSteps = 0 ),
    Exits is Choices + NextSteps,
    Exits < 2.

false_gate_reason(C, constant_false) :-
    gate(C, E, _), \+ has_vars(E), const_eval(E, bool(false)), !.
false_gate_reason(C, initials_false) :-
    gate(C, E, _),
    forall(expr_var(E, V), (variable(V, _, I, _), I \== late_bound, \+ mutated(V))),
    eval_with_initials(E, bool(false)), !.
false_gate_reason(_, unsatisfiable).

graph_findings_json(Json) :-
    findall(Dict, graph_finding_dict(Dict), Dicts0),
    sort(Dicts0, Dicts),
    atom_json_dict(Atom, _{findings:Dicts}, []),
    atom_string(Atom, Json).

graph_finding_dict(_{code:Code, severity:Severity, line:Line,
                     variant:Variant, data:Data}) :-
    graph_finding(Code, Severity, Line, Shape),
    graph_shape_dict(Shape, Variant, Data).

graph_shape_dict(dead_end(N), null, _{id:N}).
graph_shape_dict(unreachable(N, S), null, _{id:N, start:S}).
graph_shape_dict(undeclared_cycle(Path), null, _{path:Path}).
graph_shape_dict(loop_exit(N), null, _{id:N}).
graph_shape_dict(false_gate(C, Reason), null, _{choiceId:C, reasonKey:Reason}).
graph_shape_dict(loop_not_cycle(C), null, _{choiceId:C}).
graph_shape_dict(unverified_gate(C, loop_exit), "loop-exit", _{choiceId:C}).
graph_shape_dict(unverified_gate(C, choice), null, _{choiceId:C}).
graph_shape_dict(loop_once(C), null, _{choiceId:C}).
graph_shape_dict(timebox_without_alternative(N), null, _{id:N}).

/* ═════════════════════ 5 · Query library ═══════════════════════════════
 *
 * For interrogating a plan — `marionette query plan.mar '<goal>'` or the
 * interactive toplevel. Not part of the oracle report.
 */

%% reaches(?A, ?B) — phase A can reach phase B.
reaches(A, B) :- can_reach(A, B).

%% cyclic(?N) — N lies on some effective cycle.
cyclic(N) :- node(N, _, _), can_reach(N, N).

%% human_gate(?C, ?N, ?Label) — every authored human checkpoint.
human_gate(C, N, Label) :- human(C), choice(C, N, _, _, _), label(C, Label).

%% elicitation_gate(?C, ?N, ?Label) — every authored trusted-interaction fact.
elicitation_gate(C, N, Label) :- ask(C), choice(C, N, _, _, _), label(C, Label).

%% speculative(?N) — a timeboxed phase (try it; abandon if the budget dries up).
speculative(N) :- timebox(N, _).
speculative(N) :- timeout_choice(C, _, _), choice(C, N, _, _, _).

% Steps an agent may take alone: automatic next steps and non-human choices.
agent_step(F, T) :- next_step(F, T, _).
agent_step(F, T) :- eff_choice_edge(C, F, T), \+ human(C), \+ ask(C).

:- table agent_reach/2.
agent_reach(A, B) :- agent_step(A, B).
agent_reach(A, B) :- agent_step(A, M), \+ end_id(M), node(M, _, _), agent_reach(M, B).

%% unattended_completion — the agent can reach END with no human decision.
unattended_completion :- plan_start(S), end_id(E), agent_reach(S, E).

%% unattended_phase(?N) — reachable and completable with no human anywhere
%% on the path.
unattended_phase(N) :-
    plan_start(S), end_id(E), node(N, _, _),
    ( N == S ; agent_reach(S, N) ), agent_reach(N, E).

/* ═════════════════════ 6 · Engine plumbing ═════════════════════════════ */

%% reset_plan: retract the loaded plan's facts and drop memoized tables, so
%% one engine (e.g. the bundled wasm build) can check many plans in sequence.
reset_plan :-
    retractall(plan_start(_)),
    retractall(node(_, _, _)),
    retractall(variable(_, _, _, _)),
    retractall(action(_, _, _, _, _)),
    retractall(observation(_, _, _)),
    retractall(choice(_, _, _, _, _)),
    retractall(label(_, _)),
    retractall(sticky(_)),
    retractall(human(_)),
    retractall(ask(_)),
    retractall(loop_marked(_)),
    retractall(gate(_, _, _)),
    retractall(next_step(_, _, _)),
    retractall(timebox(_, _)),
    retractall(timeout_choice(_, _, _)),
    retractall(priority(_, _)),
    abolish_all_tables.

%% report: print every finding on stdout (the oracle protocol above).
report :-
    findall(Code-Line, finding(Code, Line), Fs0),
    sort(Fs0, Fs),
    forall(member(Code-Line, Fs), format("~w\t~w~n", [Code, Line])),
    findall(Ns, undeclared_cycle(Ns), Cycles0),
    sort(Cycles0, Cycles),
    forall(member(Ns, Cycles),
           ( atomic_list_concat(Ns, '->', Path), format("MAR008\t~w~n", [Path]) )),
    findall(L, stranding(_, L), Ss0),
    sort(Ss0, Ss),
    forall(member(L, Ss), format("STRAND\t~w~n", [L])).

/* ═════════════════════ 7 · Walker semantics ════════════════════════════
 *
 * Traversal is a pure relation over explicit semantic state:
 *
 *   state(Status, Current, Vars, Taken, Pending, PendingEntry, ActivatedAtMs)
 *
 * Plan facts remain the immutable environment. Timestamps, audit logs and
 * persistence stay in the TypeScript driver; the rules decide availability,
 * refusal precedence and the complete semantic state transition.
 */

initial_state(Now, State) :-
    findall(Name-Init,
            (variable(Name, _, Init, _), Init \== late_bound),
            Vars),
    findall(Name, variable(Name, _, late_bound, _), Pending),
    plan_start(Start),
    Base = state(active, Start, Vars, [], Pending, false, Now),
    ( Pending == []
    -> enter_state(Start, Now, Base, State)
    ;  set_pending_entry(Base, true, State)
    ).

set_pending_entry(
    state(Status, Current, Vars, Taken, Pending, _, Activated),
    Flag,
    state(Status, Current, Vars, Taken, Pending, Flag, Activated)
).

%% available/3 and blocked/5 are the evaluated frontier.
available(State, Now, C) :-
    State = state(active, N, _, _, _, _, _),
    choice(C, N, _, _, _),
    \+ blocked(State, Now, C, _, _).

blocked(state(active, _, _, _, Pending, _, _), _, _,
        'observation-required', observation_required(Pending)) :-
    Pending \== [], !.
blocked(state(active, _, _, Taken, _, _, _), _, C,
        'once-exhausted', once_exhausted) :-
    \+ sticky(C), memberchk(C, Taken), !.
blocked(state(active, _, _, _, _, _, Activated), Now, C,
        'timeout-pending', timeout_pending(Source, RemainingMs)) :-
    timeout_choice(C, Seconds, Source),
    elapsed_ms(Now, Activated, Elapsed),
    Limit is Seconds * 1000,
    Elapsed < Limit,
    RemainingMs is Limit - Elapsed, !.
blocked(state(active, N, _, _, _, _, Activated), Now, C,
        'timed-out', timed_out(Source)) :-
    \+ timeout_choice(C, _, _),
    choice(C, N, _, _, _),
    choice(T, N, _, _, _), timeout_choice(T, Seconds, Source),
    elapsed_ms(Now, Activated, Elapsed),
    Elapsed >= Seconds * 1000, !.
blocked(state(active, _, Vars, _, _, _, _), _, C,
        'gate-blocked', Detail) :-
    gate(C, E, Source),
    gate_runtime(E, Vars, Verdict),
    Verdict \== open,
    gate_detail(Source, Verdict, Detail).

elapsed_ms(Now, Activated, Elapsed) :-
    ( number(Activated), Activated >= 0 -> Elapsed is max(0, Now - Activated)
    ; Elapsed = 0
    ).

gate_runtime(E, Vars, open) :- once(eval(E, Vars, bool(true))), !.
gate_runtime(E, Vars, closed(V)) :- once(eval(E, Vars, V)), !.
gate_runtime(_, _, error).

gate_detail(Source, closed(V), gate_false(Source, Text)) :-
    value_text(V, Text).
gate_detail(Source, error, gate_error(Source)).

value_text(num(N), Text) :- number_string(N, Text).
value_text(bool(B), Text) :- atom_string(B, Text).
value_text(str(S), S).

%% refusal/5 fixes refusal precedence and returns presentation-neutral detail.
refusal(_, state(completed, _, _, _, _, _, _), _, completed, completed) :- !.
refusal(choose(Ref, _, _), State, _, Code, Detail) :-
    State = state(active, N, _, _, _, _, _),
    \+ resolve_choice(N, Ref, _),
    resolve_error(N, Ref, Code, Detail), !.
refusal(choose(Ref, _, _), State, Now, Code, Detail) :-
    State = state(active, N, _, _, _, _, _),
    resolve_choice(N, Ref, C),
    blocked(State, Now, C, Code, Blocked),
    Detail = choice_blocked(C, Blocked), !.
refusal(choose(Ref, Actor, _), state(active, N, _, _, _, _, _), _,
        'human-checkpoint', human_checkpoint(C)) :-
    resolve_choice(N, Ref, C), human(C), agent_actor(Actor), !.
refusal(choose(Ref, _, false), state(active, N, _, _, _, _, _), _,
        'rationale-required', rationale_required(C)) :-
    resolve_choice(N, Ref, C), !.
refusal(advance, state(active, _, _, _, Pending, _, _), _,
        'observation-required', observation_required(Pending)) :-
    Pending \== [], !.
refusal(advance, state(active, N, _, _, _, _, Activated), Now,
        'timed-out', timed_out(Source)) :-
    choice(T, N, _, _, _), timeout_choice(T, Seconds, Source),
    elapsed_ms(Now, Activated, Elapsed), Elapsed >= Seconds * 1000, !.
refusal(advance, state(active, N, _, _, _, _, _), _,
        'no-next-step', no_next_step(N)) :-
    \+ next_step(N, _, _), !.
refusal(observe(Name, _, _), state(active, _, _, _, Pending, _, _), _,
        'unknown-observation', unknown_observation(Name)) :-
    \+ memberchk(Name, Pending), !.
refusal(observe(_, _, false), state(active, _, _, _, _, _, _), _,
        'rationale-required', observation_rationale_required) :- !.
refusal(observe(Name, Value, true), state(active, _, _, _, _, _, _), _,
        'observation-type', observation_type(Name, Expected, Actual)) :-
    variable(Name, Expected, _, _),
    \+ observation_type(Name, Value),
    value_type(Value, Actual), !.

%% apply/5 is atomic: a refusal returns the input state unchanged.
apply(Op, State, Now, State, refused(Code, Detail)) :-
    refusal(Op, State, Now, Code, Detail), !.
apply(choose(Ref, _, true), StateIn, Now, StateOut, moved(C, From, To)) :-
    StateIn = state(active, From, _, _, _, _, _),
    resolve_choice(From, Ref, C),
    consume_choice(C, StateIn, Consumed),
    choice(C, From, To, _, _),
    enter_state(To, Now, Consumed, StateOut).
apply(advance, StateIn, Now, StateOut, moved(none, From, To)) :-
    StateIn = state(active, From, _, _, _, _, _),
    next_step(From, To, _),
    enter_state(To, Now, StateIn, StateOut).
apply(observe(Name, Value, true), StateIn, _, StateOut, observed(Name)) :-
    StateIn = state(active, Current, Vars, Taken, Pending, PendingEntry, Activated),
    set_env(Name, Value, Vars, Vars1),
    select(Name, Pending, Pending1),
    Base = state(active, Current, Vars1, Taken, Pending1, PendingEntry, Activated),
    ( PendingEntry == true, Pending1 == []
    -> apply_entry(Current, Base, Entered),
       set_pending_entry(Entered, false, StateOut)
    ;  StateOut = Base
    ).

consume_choice(C,
    state(Status, Current, Vars, Taken, Pending, PendingEntry, Activated),
    state(Status, Current, Vars, Taken1, Pending, PendingEntry, Activated)) :-
    ( sticky(C) -> Taken1 = Taken ; append(Taken, [C], Taken1) ).

enter_state(To, _, state(_, _, Vars, Taken, Pending, PendingEntry, _),
            state(completed, To, Vars, Taken, Pending, PendingEntry, -1)) :-
    end_id(To), !.
enter_state(To, Now,
            state(_, Current, Vars, Taken, Pending, PendingEntry, Activated),
            StateOut) :-
    ( To == Current -> Activated1 = Activated ; Activated1 = Now ),
    Base = state(active, To, Vars, Taken, Pending, PendingEntry, Activated1),
    ( PendingEntry == true -> StateOut = Base ; apply_entry(To, Base, StateOut) ).

apply_entry(Node,
            state(Status, Current, Vars, Taken, Pending, PendingEntry, Activated),
            state(Status, Current, Vars2, Taken, Pending2, PendingEntry, Activated)) :-
    findall(action(Var, Op, Expr), action(Node, Var, Op, Expr, _), Actions),
    apply_actions(Actions, Vars, Vars1),
    findall(Var, observation(Node, Var, _), Observations),
    arm_observations(Observations, Vars1, Pending, Vars2, Pending2).

apply_actions([], Vars, Vars).
apply_actions([action(Var, Op, Expr)|Rest], Vars0, Vars) :-
    once(eval(Expr, Vars0, Value)),
    action_value(Var, Op, Value, Vars0, New),
    set_env(Var, New, Vars0, Vars1),
    apply_actions(Rest, Vars1, Vars).

action_value(_, assign, Value, _, Value).
action_value(Var, inc, num(D), Vars, num(N)) :-
    memberchk(Var-num(Current), Vars), N is Current + D.
action_value(Var, dec, num(D), Vars, num(N)) :-
    memberchk(Var-num(Current), Vars), N is Current - D.

arm_observations([], Vars, Pending, Vars, Pending).
arm_observations([Name|Rest], Vars0, Pending0, Vars, Pending) :-
    remove_env(Name, Vars0, Vars1),
    ( memberchk(Name, Pending0) -> Pending1 = Pending0
    ; append(Pending0, [Name], Pending1)
    ),
    arm_observations(Rest, Vars1, Pending1, Vars, Pending).

set_env(Name, Value, Vars0, [Name-Value|Rest]) :- remove_env(Name, Vars0, Rest).
remove_env(_, [], []).
remove_env(Name, [Name-_|Rest], Rest) :- !.
remove_env(Name, [Pair|Rest0], [Pair|Rest]) :- remove_env(Name, Rest0, Rest).

agent_actor(Actor) :- ( Actor == "" ; Actor == "agent" ), !.

observation_type(Name, num(_))  :- variable(Name, number, _, _).
observation_type(Name, bool(_)) :- variable(Name, boolean, _, _).
observation_type(Name, str(_))  :- variable(Name, string, _, _).

value_type(num(_), number).
value_type(bool(_), boolean).
value_type(str(_), string).
value_type(invalid(Type), Type).

/* Choice resolution — id, numeric index, then an unambiguous
 * case-insensitive label prefix. */

resolve_choice(N, Ref, C) :- choice(C, N, _, _, _), atom_string(C, Ref), !.
resolve_choice(N, Ref, C) :-
    catch(number_string(I, Ref), _, fail), integer(I), I >= 0, !,
    nth_choice(N, I, C).
resolve_choice(N, Ref, C) :-
    findall(X, label_prefix_match(N, Ref, X), [C]).

nth_choice(N, I, C) :-
    findall(Ord-X, choice(X, N, _, _, Ord), Pairs0),
    msort(Pairs0, Pairs),
    nth0(I, Pairs, _-C).

label_prefix_match(N, Ref, C) :-
    choice(C, N, _, _, _), label(C, L),
    string_lower(Ref, RefLow), string_lower(L, LLow),
    string_concat(RefLow, _, LLow).

resolve_error(N, Ref, 'ambiguous-choice', ambiguous_choice(Ref, N)) :-
    findall(X, label_prefix_match(N, Ref, X), Ms), length(Ms, K), K > 1, !.
resolve_error(N, Ref, 'unknown-choice', bad_index(N, I, Count)) :-
    catch(number_string(I, Ref), _, fail), integer(I), I >= 0,
    findall(C, choice(C, N, _, _, _), Cs), length(Cs, Count), !.
resolve_error(N, Ref, 'unknown-choice', unknown_choice(Ref, N)).

/* JSON bridge. The JavaScript adapter supplies bound JSON strings, never
 * source-interpolated values. */

walk_init_json(NowInput, Json) :-
    input_number(NowInput, Now),
    initial_state(Now, State),
    state_dict(State, Dict),
    result_json(_{ok:true, state:Dict, effect:_{kind:"initialized"}}, Json).

walk_frontier_json(StateJson, NowInput, Json) :-
    input_number(NowInput, Now),
    json_state(StateJson, State),
    findall(Ord-Item, frontier_item(State, Now, Ord, Item), Pairs),
    keysort(Pairs, Sorted), pair_values(Sorted, Items),
    result_json(_{frontier:Items}, Json).

frontier_item(State, Now, Ord, Item) :-
    State = state(active, N, _, _, _, _, _),
    choice(C, N, _, _, Ord),
    ( blocked(State, Now, C, Code, Detail)
    -> detail_dict(Detail, DetailDict),
       Item = _{choiceId:C, blockedCode:Code, detail:DetailDict}
    ;  Item = _{choiceId:C, blockedCode:null, detail:_{}}
    ).

walk_apply_json(StateJson, OperationJson, NowInput, Json) :-
    input_number(NowInput, Now),
    json_state(StateJson, StateIn),
    json_operation(OperationJson, Operation),
    apply(Operation, StateIn, Now, StateOut, Outcome),
    state_dict(StateOut, StateDict),
    outcome_dict(Outcome, OutcomeDict),
    Result = OutcomeDict.put(state, StateDict),
    result_json(Result, Json).

json_state(Json, State) :-
    json_input(Json, Dict),
    get_dict(status, Dict, StatusString), atom_string(Status, StatusString),
    get_dict(current, Dict, CurrentString), atom_string(Current, CurrentString),
    get_dict(variables, Dict, PlainVars), variables_from_dict(PlainVars, Vars),
    get_dict(taken, Dict, TakenStrings), atoms_strings(Taken, TakenStrings),
    get_dict(pendingObservations, Dict, PendingStrings), atoms_strings(Pending, PendingStrings),
    get_dict(pendingEntry, Dict, PendingEntry),
    get_dict(activationStartedAtMs, Dict, Activated),
    State = state(Status, Current, Vars, Taken, Pending, PendingEntry, Activated).

state_dict(state(Status, Current, Vars, Taken, Pending, PendingEntry, Activated),
           _{status:StatusString, current:CurrentString, variables:PlainVars,
             taken:TakenStrings, pendingObservations:PendingStrings,
             pendingEntry:PendingEntry, activationStartedAtMs:Activated}) :-
    atom_string(Status, StatusString),
    atom_string(Current, CurrentString),
    variables_dict(Vars, PlainVars),
    atoms_strings(Taken, TakenStrings),
    atoms_strings(Pending, PendingStrings).

variables_from_dict(Dict, Vars) :-
    dict_pairs(Dict, _, Pairs),
    findall(Name-Value,
            (member(Name-Plain, Pairs), variable(Name, Type, _, _),
             plain_typed(Type, Plain, Value)),
            Vars).

variables_dict(Vars, Dict) :-
    findall(Name-Plain,
            (member(Name-Value, Vars), typed_plain(Value, Plain)),
            Pairs),
    dict_pairs(Dict, _, Pairs).

plain_typed(number, Plain, num(Plain)).
plain_typed(boolean, Plain, bool(Plain)).
plain_typed(string, Plain, str(Plain)).

typed_plain(num(Value), Value).
typed_plain(bool(Value), Value).
typed_plain(str(Value), Value).

atoms_strings([], []).
atoms_strings([Atom|Atoms], [String|Strings]) :-
    atom_string(Atom, String), atoms_strings(Atoms, Strings).

json_operation(Json, Operation) :-
    json_input(Json, Dict),
    get_dict(kind, Dict, Kind),
    operation_dict(Kind, Dict, Operation).

operation_dict("choose", Dict, choose(Ref, Actor, HasRationale)) :-
    get_dict(ref, Dict, Ref),
    get_dict(actor, Dict, Actor),
    get_dict(hasRationale, Dict, HasRationale).
operation_dict("advance", _, advance).
operation_dict("observe", Dict, observe(Name, Value, HasRationale)) :-
    get_dict(name, Dict, NameString), atom_string(Name, NameString),
    get_dict(valueType, Dict, TypeString), atom_string(Type, TypeString),
    get_dict(value, Dict, Plain),
    operation_value(Type, Plain, Value),
    get_dict(hasRationale, Dict, HasRationale).

operation_value(number, Plain, num(Plain)) :- number(Plain), !.
operation_value(boolean, Plain, bool(Plain)) :- memberchk(Plain, [true, false]), !.
operation_value(string, Plain, str(Plain)) :- string(Plain), !.
operation_value(Type, _, invalid(Type)).

outcome_dict(refused(Code, Detail),
             _{ok:false, code:Code, detail:DetailDict}) :-
    detail_dict(Detail, DetailDict).
outcome_dict(moved(C, From, To),
             _{ok:true, effect:_{kind:"moved", choiceId:Choice,
                                 from:From, to:To}}) :-
    ( C == none -> Choice = null ; Choice = C ).
outcome_dict(observed(Name),
             _{ok:true, effect:_{kind:"observed", name:Name}}).

detail_dict(completed, _{kind:"completed"}).
detail_dict(choice_blocked(C, Detail), Dict) :-
    detail_dict(Detail, Base),
    Dict = Base.put(choiceId, C).
detail_dict(observation_required(Names), _{kind:"observation-required", names:Strings}) :-
    atoms_strings(Names, Strings).
detail_dict(once_exhausted, _{kind:"once-exhausted"}).
detail_dict(timeout_pending(Source, Remaining), _{kind:"timeout-pending", source:Source, remainingMs:Remaining}).
detail_dict(timed_out(Source), _{kind:"timed-out", source:Source}).
detail_dict(gate_false(Source, Value), _{kind:"gate-false", source:Source, value:Value}).
detail_dict(gate_error(Source), _{kind:"gate-error", source:Source}).
detail_dict(human_checkpoint(C), _{kind:"human-checkpoint", choiceId:C}).
detail_dict(rationale_required(C), _{kind:"rationale-required", choiceId:C}).
detail_dict(no_next_step(N), _{kind:"no-next-step", nodeId:N}).
detail_dict(unknown_observation(Name), _{kind:"unknown-observation", name:Name}).
detail_dict(observation_rationale_required, _{kind:"observation-rationale-required"}).
detail_dict(observation_type(Name, Expected, Actual),
            _{kind:"observation-type", name:Name, expected:Expected, actual:Actual}).
detail_dict(ambiguous_choice(Ref, N), _{kind:"ambiguous-choice", ref:Ref, nodeId:N}).
detail_dict(bad_index(N, I, Count), _{kind:"bad-index", nodeId:N, index:I, count:Count}).
detail_dict(unknown_choice(Ref, N), _{kind:"unknown-choice", ref:Ref, nodeId:N}).

json_input(Json, Dict) :-
    atom_string(Atom, Json),
    atom_json_dict(Atom, Dict, []).

% swipl-wasm's direct numeric bindings are 32-bit. Millisecond epochs travel
% as decimal strings so dates after 1970 are not truncated at the JS boundary.
input_number(Number, Number) :- number(Number), !.
input_number(Atom, Number) :- atom(Atom), atom_number(Atom, Number), !.
input_number(String, Number) :- number_string(Number, String).

result_json(Dict, Json) :-
    atom_json_dict(Atom, Dict, []),
    atom_string(Atom, Json).

pair_values([], []).
pair_values([_-Value|Rest], [Value|Values]) :- pair_values(Rest, Values).
