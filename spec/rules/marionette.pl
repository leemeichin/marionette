:- encoding(utf8).
/*  Marionette graph semantics — NORMATIVE (ADR-0003).
 *
 *  A compiled plan is a database of facts (see spec/rules/README.md for the
 *  schema; `marionette facts plan.mar` emits it). This file is the
 *  specification of Marionette's graph-layer diagnostics: each MAR code is
 *  one clause stating the defect as a claim about the graph. An
 *  implementation conforms iff it reproduces finding/2 — code and line — on
 *  the vectors in spec/conformance/graph/ and stays divergence-free under
 *  the differential harness (tests/oracle.test.ts, which holds the
 *  TypeScript implementation in src/validate.ts to this file on every push).
 *  Wording, suggestions and exit codes are implementation presentation, out
 *  of scope here. The file also provides a query library for interrogating
 *  a plan interactively.
 *
 *  Usage:
 *    swipl -g report -t halt spec/rules/marionette.pl plan.pl   % oracle output
 *    swipl spec/rules/marionette.pl plan.pl                     % interactive
 *
 *  Report protocol (one finding per line, tab-separated):
 *    MAR006..MAR017 <line>        exact-match diagnostics
 *    MAR008 <n1->n2->...>         an effective simple cycle with no ~loop~ edge
 *    STRAND <line>                once-only choice on a cycle (issue #8 item 2;
 *                                 not yet implemented in the TS validator)
 */

:- dynamic plan_start/1, node/3, variable/4, action/5, choice/5,
           label/2, sticky/1, human/1, loop_marked/1, gate/3, divert/3,
           timebox/2, priority/2.
:- discontiguous finding/2.

end_id('END').

/* ===================== expression evaluation =====================
 * Mirrors src/expr.ts evalExpr: values are typed terms num(N) | bool(B) |
 * str(S); type errors simply fail (the TS evaluator throws, and callers
 * treat a throw as "no verdict").
 */

bool_not(true, false).
bool_not(false, true).

eval(lit(V), _, V).
eval(var(N), Env, V) :- memberchk(N-V, Env).
eval(un(not, E), Env, bool(R)) :- eval(E, Env, bool(B)), bool_not(B, R).
eval(un(neg, E), Env, num(R)) :- eval(E, Env, num(N)), R is -N.
eval(bin(and, L, R), Env, bool(V)) :-
    eval(L, Env, bool(BL)),
    ( BL == false -> V = false ; eval(R, Env, bool(V)) ).
eval(bin(or, L, R), Env, bool(V)) :-
    eval(L, Env, bool(BL)),
    ( BL == true -> V = true ; eval(R, Env, bool(V)) ).
eval(bin(eq, L, R), Env, bool(V)) :-
    eval(L, Env, VL), eval(R, Env, VR), eq_val(VL, VR, V).
eval(bin(ne, L, R), Env, bool(V)) :-
    eval(L, Env, VL), eval(R, Env, VR), eq_val(VL, VR, E), bool_not(E, V).
eval(bin(Op, L, R), Env, bool(V)) :-
    num_cmp(Op),
    eval(L, Env, num(A)), eval(R, Env, num(B)),
    ( cmp_holds(Op, A, B) -> V = true ; V = false ).
eval(bin(add, L, R), Env, V) :-
    eval(L, Env, VL), eval(R, Env, VR),
    (  VL = str(A), VR = str(B) -> string_concat(A, B, S), V = str(S)
    ;  VL = num(A), VR = num(B) -> N is A + B, V = num(N)
    ).
eval(bin(sub, L, R), Env, num(V)) :- eval(L, Env, num(A)), eval(R, Env, num(B)), V is A - B.
eval(bin(mul, L, R), Env, num(V)) :- eval(L, Env, num(A)), eval(R, Env, num(B)), V is A * B.
eval(bin(div, L, R), Env, num(V)) :- eval(L, Env, num(A)), eval(R, Env, num(B)), B =\= 0, V is A / B.
eval(bin(mod, L, R), Env, num(V)) :-      % JS remainder: sign follows the dividend
    eval(L, Env, num(A)), eval(R, Env, num(B)), B =\= 0, V is A - B * truncate(A / B).

eq_val(num(A),  num(B),  V) :- ( A =:= B -> V = true ; V = false ).
eq_val(bool(A), bool(B), V) :- ( A == B  -> V = true ; V = false ).
eq_val(str(A),  str(B),  V) :- ( A == B  -> V = true ; V = false ).

num_cmp(lt). num_cmp(le). num_cmp(gt). num_cmp(ge).
cmp_holds(lt, A, B) :- A < B.
cmp_holds(le, A, B) :- A =< B.
cmp_holds(gt, A, B) :- A > B.
cmp_holds(ge, A, B) :- A >= B.

expr_var(var(N), N).
expr_var(un(_, E), N) :- expr_var(E, N).
expr_var(bin(_, L, R), N) :- ( expr_var(L, N) ; expr_var(R, N) ).
has_vars(E) :- expr_var(E, _), !.

const_eval(E, V) :- \+ has_vars(E), once(eval(E, [], V)).

eval_with_initials(E, V) :-
    setof(N-I, T^L^(expr_var(E, N), variable(N, T, I, L)), Env),
    once(eval(E, Env, V)).

/* ===================== gate analysis =====================
 * Mirrors src/gates.ts analyzeGate / eventuallyFalse. A Scope is `all`
 * (every mutation in the graph) or nodes(Ms) (mutations inside a cycle's
 * SCC); the monotonicity step additionally requires the global direction
 * to agree, exactly as the TS analysis does.
 */

mutated(Var) :- action(_, Var, _, _, _), !.

scope_action(all, Var, Op, ValExpr) :- action(_, Var, Op, ValExpr, _).
scope_action(nodes(Ms), Var, Op, ValExpr) :- member(M, Ms), action(M, Var, Op, ValExpr, _).

action_delta(assign, _, unknown).
action_delta(inc, ValExpr, D) :- step_sign(ValExpr,  1, D).
action_delta(dec, ValExpr, D) :- step_sign(ValExpr, -1, D).
step_sign(ValExpr, Mul, D) :-
    (  const_eval(ValExpr, num(S)), S =\= 0
    -> ( S * Mul > 0 -> D = pos ; D = neg )
    ;  D = unknown ).

%% direction(+Var, +Scope, -Dir): inc | dec | none | unknown.
direction(Var, Scope, Dir) :-
    findall(D, ( scope_action(Scope, Var, Op, V), action_delta(Op, V, D) ), Ds),
    (  Ds == [] -> Dir = none
    ;  memberchk(unknown, Ds) -> Dir = unknown
    ;  sort(Ds, Sorted),
       ( Sorted == [pos] -> Dir = inc ; Sorted == [neg] -> Dir = dec ; Dir = unknown )
    ).

%% counter_cmp(+Expr, -Var, -Op, -Const): `v OP k` or `k OP v` (op flipped).
counter_cmp(bin(Op, var(X), C), X, Op, K) :- cmp_like(Op), const_eval(C, num(K)).
counter_cmp(bin(Op, C, var(X)), X, F, K)  :- cmp_like(Op), const_eval(C, num(K)), flip(Op, F).
cmp_like(lt). cmp_like(le). cmp_like(gt). cmp_like(ge). cmp_like(eq). cmp_like(ne).
flip(lt, gt). flip(le, ge). flip(gt, lt). flip(ge, le). flip(eq, eq). flip(ne, ne).

%% gate_status(+Expr, +Scope, -Status): sat | unsat | unknown.
gate_status(E, Scope, Status) :-
    (  \+ has_vars(E)
    -> bool_status(const_eval(E, bool(true)), const_eval(E, bool(false)), Status)
    ;  forall(expr_var(E, V), (variable(V, _, _, _), \+ mutated(V)))
    -> bool_status(eval_with_initials(E, bool(true)), eval_with_initials(E, bool(false)), Status)
    ;  counter_sat(E, Scope)
    -> Status = sat
    ;  Status = unknown
    ).

bool_status(TrueGoal, FalseGoal, Status) :-
    (  call(TrueGoal)  -> Status = sat
    ;  call(FalseGoal) -> Status = unsat
    ;  Status = unknown
    ).

counter_sat(E, Scope) :-
    counter_cmp(E, X, Op, _),
    variable(X, number, _, _),
    direction(X, Scope, Dir), direction(X, all, Dir),
    (  Dir == inc -> memberchk(Op, [gt, ge, ne])
    ;  Dir == dec -> memberchk(Op, [lt, le, ne])
    ), !.

%% eventually_false(+Expr, +Scope): a loop-continue gate that provably shuts.
eventually_false(E, Scope) :-
    counter_cmp(E, X, Op, _),
    variable(X, number, _, _),
    direction(X, Scope, Dir), direction(X, all, Dir),
    (  Dir == inc -> memberchk(Op, [lt, le, eq])
    ;  Dir == dec -> memberchk(Op, [gt, ge, eq])
    ), !.

/* ===================== the graph ===================== */

false_gate(C) :- gate(C, E, _), gate_status(E, all, unsat).

%% Effective edges exclude choices whose gate is provably false, exactly as
%% the TS validator filters them before dead-end/reachability/cycle analysis.
eff_choice_edge(C, F, T) :- choice(C, F, T, _, _), \+ false_gate(C).
eff_edge(F, T) :- eff_choice_edge(_, F, T).
eff_edge(F, T) :- divert(F, T, _).

%% step/2: effective edges between declared nodes (END terminates every path).
step(F, T) :- eff_edge(F, T), \+ end_id(T), node(T, _, _).
%% stepa/2: the same over the unfiltered graph (per-gate cycle exemption).
stepa(F, T) :- choice(_, F, T, _, _), \+ end_id(T), node(T, _, _).
stepa(F, T) :- divert(F, T, _), \+ end_id(T), node(T, _, _).

:- table preach/2.
preach(A, B) :- step(A, B).
preach(A, B) :- step(A, M), preach(M, B).

:- table preacha/2.
preacha(A, B) :- stepa(A, B).
preacha(A, B) :- stepa(A, M), preacha(M, B).

%% on_cycle_with(+F, +T): src/validate.ts onCycleWith — self-target, or same
%% SCC of the *unfiltered* graph.
on_cycle_with(F, T) :- F == T, !.
on_cycle_with(F, T) :- \+ end_id(T), preacha(F, T), preacha(T, F).

%% same_cycle_eff(+A, +B): A and B lie on a common effective cycle.
same_cycle_eff(A, B) :- ( A == B -> preach(A, A) ; preach(A, B), preach(B, A) ).

%% scc_member(+N, -M): members of N's cyclic SCC (N itself included).
scc_member(N, N).
scc_member(N, M) :- preach(N, M), preach(M, N), M \== N.

/* ===================== diagnostics =====================
 * finding(Code, Line) — each clause is the spec of one MAR code.
 */

%% MAR006 — a phase with no effective exit is a dead end.
finding('MAR006', Line) :-
    node(N, Line, _), \+ eff_edge(N, _).

%% MAR007 — a phase (other than the start) the start cannot reach.
finding('MAR007', Line) :-
    plan_start(S),
    node(N, Line, _), N \== S, \+ preach(S, N).

%% MAR011 — a gate that can provably never open.
finding('MAR011', Line) :-
    choice(C, _, _, Line, _), false_gate(C).

%% MAR013 — a ~loop~ mark on an edge that closes no cycle.
finding('MAR013', Line) :-
    loop_marked(C), \+ false_gate(C),
    choice(C, N, T, Line, _), \+ closes_cycle(N, T).

closes_cycle(N, T) :- \+ end_id(T), same_cycle_eff(N, T).

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

/* ---- loop exits (MAR009 / MAR010 / loop-exit MAR014) ----
 * One analysis per cyclic SCC, reported at the first (source-order)
 * ~loop~-marked choice that closes a cycle in it — matching the TS
 * validator's iteration order via the emitted choice ordinals.
 */

trigger(C, N) :-
    loop_marked(C), \+ false_gate(C),
    choice(C, N, T, _, _), closes_cycle(N, T).

primary_trigger(C, N) :-
    trigger(C, N), choice(C, _, _, _, Ord),
    \+ ( trigger(C2, N2), C2 \== C, same_cycle_eff(N, N2),
         choice(C2, _, _, _, Ord2), Ord2 < Ord ).

scc_scope(N, nodes(Ms)) :- setof(M, scc_member(N, M), Ms).

%% exit_edge(+N, -Kind, -Line): edges leaving N's SCC (to END or outside).
exit_edge(N, choice(C), Line) :-
    scc_member(N, M), eff_choice_edge(C, M, T), leaves(N, T),
    choice(C, _, _, Line, _).
exit_edge(N, divert, Line) :-
    scc_member(N, M), divert(M, T, Line), leaves(N, T).

leaves(_, T) :- end_id(T), !.
leaves(N, T) :- \+ scc_member(N, T).

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
    -> ( filtered_exit(N) -> Code = 'MAR010' ; Code = 'MAR009' )
    ;  scc_scope(N, Scope),
       \+ ( exit_edge(N, Kind, _), exit_sat(Scope, Kind) ),
       forall(exit_edge(N, Kind, _), exit_unsat(Scope, Kind)),
       Code = 'MAR010'
    ).

%% An exit that existed but was filtered out as a provably-false gate.
filtered_exit(N) :-
    scc_member(N, M), choice(C, M, T, _, _), false_gate(C),
    ( end_id(T) ; \+ scc_member(N, T) ), !.

%% Loop exits that are neither provable nor refutable → unverified-gate warnings.
loop_unverified_exit(C2, Line) :-
    primary_trigger(_, N),
    scc_scope(N, Scope),
    \+ ( exit_edge(N, Kind, _), exit_sat(Scope, Kind) ),
    exit_edge(N, choice(C2), Line),
    gate(C2, E, _), gate_status(E, Scope, unknown).

%% MAR014 — gates the analysis cannot decide (loop exits first, then the
%% general pass, minus bounded loop-continue gates).
finding('MAR014', Line) :- loop_unverified_exit(_, Line).
finding('MAR014', Line) :-
    choice(C, N, T, Line, _), gate(C, E, _),
    gate_status(E, all, unknown),
    \+ bounded_loop_gate(C, N, T, E),
    \+ loop_unverified_exit(C, _).

bounded_loop_gate(C, N, T, E) :-
    ( loop_marked(C) ; on_cycle_with(N, T) ),
    eventually_false(E, all).

/* ---- MAR008: undeclared cycles (semantic form) ----
 * The intended rule, stated directly: every simple cycle in the effective
 * graph must carry at least one ~loop~-marked choice edge. The TS validator
 * approximates this with DFS back edges, so the two are diffed on presence,
 * not per-cycle (see tests/oracle.test.ts); a cycle this rule finds that the
 * DFS misses is a genuine gap in the approximation.
 */

edge_term(F, T, choice(C)) :- eff_choice_edge(C, F, T), \+ end_id(T), node(T, _, _).
edge_term(F, T, divert)    :- divert(F, T, _), \+ end_id(T), node(T, _, _).

%% undeclared_cycle(-Nodes): a simple cycle, no edge of which is ~loop~-marked.
%% Deduplicated by rotation: only reported from its minimal node.
undeclared_cycle(Nodes) :-
    node(Origin, _, _),
    simple_cycle(Origin, Nodes, Edges),
    \+ ( member(choice(C), Edges), loop_marked(C) ),
    msort(Nodes, [Origin|_]).

simple_cycle(Origin, [Origin|Ns], [E|Es]) :-
    edge_term(Origin, Next, E),
    grow(Next, Origin, [Origin], Ns, Es).
grow(Origin, Origin, _, [], []) :- !.
grow(Cur, Origin, Seen, [Cur|Ns], [E|Es]) :-
    Cur \== Origin, \+ memberchk(Cur, Seen),
    edge_term(Cur, Next, E),
    grow(Next, Origin, [Cur|Seen], Ns, Es).

has_undeclared_cycle :- undeclared_cycle(_), !.

/* ---- STRAND: once-only choices on a cycle ----
 * Issue #8 item 2: an exhausted "*" exit anywhere inside a cycle can strand
 * a traversal at runtime. Not yet a TS diagnostic — reported here so the
 * oracle surfaces the cases the compiler cannot.
 */

stranding(C, Line) :-
    choice(C, N, T, Line, _),
    \+ sticky(C), \+ false_gate(C),
    \+ end_id(T), same_cycle_eff(N, T).

/* ===================== query library =====================
 * For interrogating a plan interactively — not part of the oracle report.
 */

%% reaches(?A, ?B) — A reaches B over effective edges.
reaches(A, B) :- preach(A, B).

%% cyclic(?N) — N lies on some effective cycle.
cyclic(N) :- node(N, _, _), preach(N, N).

%% human_gate(?C, ?N, ?Label) — every authored human checkpoint.
human_gate(C, N, Label) :- human(C), choice(C, N, _, _, _), label(C, Label).

%% agent_step/2: edges an agent may take alone (no @human choices).
agent_step(F, T) :- divert(F, T, _).
agent_step(F, T) :- eff_choice_edge(C, F, T), \+ human(C).

:- table agent_reach/2.
agent_reach(A, B) :- agent_step(A, B).
agent_reach(A, B) :- agent_step(A, M), \+ end_id(M), node(M, _, _), agent_reach(M, B).

%% unattended_completion — the agent can reach END without any human gate.
unattended_completion :- plan_start(S), end_id(E), agent_reach(S, E).

%% unattended_phase(?N) — a phase the agent can reach and leave to END with no
%% human decision anywhere on the path.
unattended_phase(N) :-
    plan_start(S), end_id(E), node(N, _, _),
    ( N == S ; agent_reach(S, N) ), agent_reach(N, E).

%% speculative(?N) — a timeboxed phase (try it, abandon if the budget runs dry).
speculative(N) :- timebox(N, _).

/* ===================== engine reuse ===================== */

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

/* ===================== report ===================== */

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
