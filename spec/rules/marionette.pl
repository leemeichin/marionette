:- encoding(utf8).
/*  Marionette graph semantics — NORMATIVE (ADR-0003).
 *
 *  A compiled plan is a database of facts; this file is the specification
 *  of Marionette's graph-layer diagnostics, stated as rules over that
 *  database. Each MAR code is a clause that reads as a claim about the
 *  graph. An implementation conforms iff it reproduces finding/2 — code
 *  and line — on the vectors in spec/conformance/graph/ and stays
 *  divergence-free under the differential harness (tests/oracle.test.ts,
 *  which holds src/validate.ts to this file on every push). Wording,
 *  suggestions and exit codes are implementation presentation, out of
 *  scope here.
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
 *    variable(Name, Type, Init, Line)     VAR declaration
 *    action(Node, Var, Op, Expr, Line)    ~ mutation on entry (assign|inc|dec)
 *    choice(Id, Node, Target, Line, Ord)  an exit edge; Ord is global order
 *    label(Id, Text)                      the choice's human-readable claim
 *    sticky(Id)                           "+" repeatable ("*" when absent)
 *    human(Id)                            @human checkpoint
 *    loop_marked(Id)                      ~loop~ declared cycle edge
 *    gate(Id, Expr, Source)               {gate} as an AST + original text
 *    divert(Node, Target, Line)           unconditional fallthrough
 *    timebox(Node, Seconds)               # timebox: (speculative phases)
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
:- dynamic plan_start/1, node/3, variable/4, action/5, choice/5,
           label/2, sticky/1, human/1, loop_marked/1, gate/3, divert/3,
           timebox/2, priority/2.
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
    setof(N-I, T^L^(expr_var(E, N), variable(N, T, I, L)), Env),
    once(eval(E, Env, V)).

/* ═════════════════════ 2 · Gate analysis ═══════════════════════════════
 *
 * Mirrors src/gates.ts. The compiler only ever claims a verdict when it is
 * provable; everything else is `unknown` and surfaces as MAR014.
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
    ;  forall(expr_var(E, V), (variable(V, _, _, _), \+ mutated(V)))
    -> decide(eval_with_initials(E, bool(true)), eval_with_initials(E, bool(false)), Status)
    ;  counter_eventually_true(E, Scope)
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
 *   effective — choices whose gate is not provably false, plus diverts.
 *     Dead-end / reachability / cycle analysis all run on this graph,
 *     because a provably-false gate is an edge that never exists.
 *   unfiltered — every authored edge, used only by the per-gate MAR014
 *     exemption (a gate's cycle membership shouldn't depend on verdicts).
 */

false_gate(C) :- gate(C, E, _), gate_status(E, all, unsat).

eff_choice_edge(C, F, T) :- choice(C, F, T, _, _), \+ false_gate(C).
eff_edge(F, T) :- eff_choice_edge(_, F, T).
eff_edge(F, T) :- divert(F, T, _).

% One step between declared phases. END terminates every path, so it is
% never an intermediate node.
eff_step(F, T) :- eff_edge(F, T), \+ end_id(T), node(T, _, _).
any_step(F, T) :- choice(_, F, T, _, _), \+ end_id(T), node(T, _, _).
any_step(F, T) :- divert(F, T, _), \+ end_id(T), node(T, _, _).

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
    ( divert(N, _, _) -> Diverts = 1 ; Diverts = 0 ),
    Exits is Choices + Diverts,
    Exits < 2.

/* ── Loop exits (MAR009 / MAR010 / loop-exit MAR014) ────────────────────
 *
 * One analysis per cycle, reported at its first (source-order) ~loop~
 * choice — matching the reference implementation's iteration order via
 * the emitted ordinals. A cycle's exits are the edges leaving its member
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
exit_edge(N, divert, Line) :-
    cycle_member(N, M), divert(M, T, Line), leaves(N, T).

leaves(_, T) :- end_id(T), !.
leaves(N, T) :- \+ cycle_member(N, T).

% A divert or ungated choice is a sure exit; a gated one needs a
% satisfiable verdict (with cycle-scoped monotonicity).
exit_sat(_, divert).
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
cycle_edge(F, T, divert)    :- divert(F, T, _), \+ end_id(T), node(T, _, _).

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

%% speculative(?N) — a timeboxed phase (try it; abandon if the budget dries up).
speculative(N) :- timebox(N, _).

% Steps an agent may take alone: diverts, and choices not marked @human.
agent_step(F, T) :- divert(F, T, _).
agent_step(F, T) :- eff_choice_edge(C, F, T), \+ human(C).

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
    retractall(choice(_, _, _, _, _)),
    retractall(label(_, _)),
    retractall(sticky(_)),
    retractall(human(_)),
    retractall(loop_marked(_)),
    retractall(gate(_, _, _)),
    retractall(divert(_, _, _)),
    retractall(timebox(_, _)),
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
 * Traversal, stated as rules over the plan facts plus a small mutable
 * walk state. This is the same contract src/state.ts implements and
 * spec/conformance/cases/ exercises — the conformance suite runs BOTH
 * walkers (issue #21, phase C). Timestamps, log persistence and file
 * formats are the driver's concern; the rules own what may happen and
 * what it changes.
 *
 * Walk state (dynamic):
 *   w_current(Node)    the phase the traversal is at ('END' when done)
 *   w_status(S)        active | completed
 *   w_var(Name, V)     live variables (typed values: num/bool/str)
 *   w_taken(ChoiceId)  once-only choices already consumed
 *
 * Driver API:
 *   init_walk                       fresh state; enters the start phase
 *   do_choose(Ref, Actor, HasRationale, Result)
 *   do_advance(Result)
 *   Result = moved(To) | refused(Code)   — a refusal changes nothing.
 *   walk_var(Name, Type, Plain)     read variables back, untyped
 */

:- dynamic w_current/1, w_status/1, w_var/2, w_taken/1.

init_walk :-
    retractall(w_current(_)), retractall(w_status(_)),
    retractall(w_var(_, _)), retractall(w_taken(_)),
    assertz(w_status(active)),
    forall(variable(Name, _, Init, _), assertz(w_var(Name, Init))),
    plan_start(S),
    enter_node(S).

% Entering a phase: END completes the walk; anything else becomes current
% and applies its mutations in source order (later mutations see earlier
% ones, so `~ n += 1` twice adds two).
enter_node(T) :-
    end_id(T), !,
    retractall(w_current(_)), assertz(w_current(T)),
    retractall(w_status(_)), assertz(w_status(completed)).
enter_node(T) :-
    retractall(w_current(_)), assertz(w_current(T)),
    forall(action(T, Var, Op, Expr, _), apply_action(Var, Op, Expr)).

apply_action(Var, Op, Expr) :-
    walk_env(Env),
    once(eval(Expr, Env, V)),
    (  Op == assign -> New = V
    ;  w_var(Var, num(Cur)), V = num(D),
       ( Op == inc -> N is Cur + D ; N is Cur - D ), New = num(N)
    ),
    retract(w_var(Var, _)), assertz(w_var(Var, New)).

walk_env(Env) :- findall(N-V, w_var(N, V), Env).

%% available(?C) / walk_blocked(+C, -Code): the live frontier at w_current.
%% Once-only exhaustion is checked before the gate, as in the reference.
available(C) :- w_current(N), choice(C, N, _, _, _), \+ walk_blocked(C, _).
walk_blocked(C, 'once-exhausted') :- \+ sticky(C), w_taken(C), !.
walk_blocked(C, 'gate-blocked') :-
    gate(C, E, _), walk_env(Env), \+ once(eval(E, Env, bool(true))).

%% do_choose(+Ref, +Actor, +HasRationale, -Result)
%% Refusal order matches the reference walker: completed → resolution →
%% availability → @human actor → rationale. A refusal changes nothing.
do_choose(_, _, _, refused(completed)) :- w_status(completed), !.
do_choose(Ref, Actor, HasRationale, Result) :-
    w_current(N),
    (  resolve_choice(N, Ref, C)
    -> (  walk_blocked(C, Code)          -> Result = refused(Code)
       ;  human(C), agent_actor(Actor)   -> Result = refused('human-checkpoint')
       ;  HasRationale == false          -> Result = refused('rationale-required')
       ;  take_choice(C, Result)
       )
    ;  resolve_error(N, Ref, Code), Result = refused(Code)
    ).

agent_actor(Actor) :- ( Actor == "" ; Actor == "agent" ), !.

take_choice(C, moved(To)) :-
    ( sticky(C) -> true ; assertz(w_taken(C)) ),
    choice(C, _, To, _, _),
    enter_node(To).

%% do_advance(-Result): follow the fallthrough divert. No rationale is
%% required (the reference defaults it), matching src/state.ts advance.
do_advance(refused(completed)) :- w_status(completed), !.
do_advance(Result) :-
    w_current(N),
    (  divert(N, To, _) -> enter_node(To), Result = moved(To)
    ;  Result = refused('no-divert')
    ).

/* Choice resolution — id, then numeric index, then unambiguous
 * case-insensitive label prefix; the same order as the reference. */

resolve_choice(N, Ref, C) :- choice(C, N, _, _, _), atom_string(C, Ref), !.
resolve_choice(N, Ref, C) :-
    number_string(I, Ref), integer(I), I >= 0, !,
    nth_choice(N, I, C).
resolve_choice(N, Ref, C) :-
    findall(X, label_prefix_match(N, Ref, X), [C]).

% The node's choices in source order, picked by position.
nth_choice(N, I, C) :-
    findall(Ord-X, choice(X, N, _, _, Ord), Pairs0),
    msort(Pairs0, Pairs),
    nth0(I, Pairs, _-C).

label_prefix_match(N, Ref, C) :-
    choice(C, N, _, _, _), label(C, L),
    string_lower(Ref, RefLow), string_lower(L, LLow),
    string_concat(RefLow, _, LLow).

%% resolve_error(+N, +Ref, -Code): why resolution failed.
resolve_error(N, Ref, 'ambiguous-choice') :-
    findall(X, label_prefix_match(N, Ref, X), Ms), length(Ms, K), K > 1, !.
resolve_error(_, _, 'unknown-choice').

/* Driver plumbing: flat results (atoms, not compounds) for the wasm
 * bridge, and typed variable read-back. */

walk_var(Name, number,  X) :- w_var(Name, num(X)).
walk_var(Name, boolean, X) :- w_var(Name, bool(X)).
walk_var(Name, string,  X) :- w_var(Name, str(X)).

%% drive_choose/drive_advance: Outcome is `ok` or the refusal code.
drive_choose(Ref, Actor, HasRationale, Outcome) :-
    do_choose(Ref, Actor, HasRationale, R),
    ( R = refused(Code) -> Outcome = Code ; Outcome = ok ).
drive_advance(Outcome) :-
    do_advance(R),
    ( R = refused(Code) -> Outcome = Code ; Outcome = ok ).
