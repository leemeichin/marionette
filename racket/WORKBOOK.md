# Build Marionette in Racket: the 48-hour workbook

This is a workshop with locked doors, not a porting recipe. You choose the
representations and write the language. Each mission gives you an observable
finish line, invariants that protect Marionette's contract, questions worth
sitting with, and optional clues. Open clues only when the struggle has stopped
being useful.

The TypeScript/SWI implementation is an oracle, not a template. Compare its
inputs and outputs; do not translate its internal structure line by line.

## How to use the workbook

- Work in `racket/`; leave the existing implementation unchanged.
- Start each mission by writing down your current answer to its design
  questions.
- Run only the named black-box checks until you want a tighter feedback loop.
- Record a short decision note at each reflection checkpoint.
- Reorder missions if a discovery makes that sensible, but do not weaken an
  invariant silently.
- Ask AI for review, an explanation of a failed invariant, or exactly one hint
  level. AI does not write the production solution.

The 48 hours are an orientation target, not a deadline. A precise account of
where the experiment stopped is a successful result.

## Baseline and honest scope

The initial oracle is TypeScript/SWI at `ce70e14`. Record any later baseline
advance before accepting new reference output; never regenerate parity hashes
merely to make a check green.

This workbook proves that the source model, semantic split, diagnostics,
transition boundary, imports and distribution feel viable in Racket. It does
**not** promise full Marionette parity in 48 hours. In particular, complete
runtime persistence, future-only amendments, every refusal precedence case and
the Pi process-adapter migration belong to the post-slice work below.

Current gate names matter while reading older bootstrap material:

- `@ask` — a trusted operator chooses an authored route;
- `@input` — the agent opens a focused question and a human answer follows the
  fixed route;
- `@human` — a human attests an action with identity and durable evidence.

Archived spec-0.5 trajectories used `@ask` for elicitation. Preserve that
meaning only when replaying those old graph epochs.

## Mission 0 — portable seed

### Outcome

Produce a self-contained archive whose `marionette --version` command works on
a clean machine without Node, npm, Racket, or SWI-Prolog.

### Invariants

- The archive is built from this source tree.
- Unpacking is the only installation step required for the smoke test.
- Datalog and Racklog are present in the assembled distribution.
- The target triple and Racket version are recorded beside the archive.

### Finish condition

The distribution workflow passes for `x86_64-linux`, `aarch64-linux`, and
`aarch64-macos`; its evidence files record size, build time, and startup time.

### Design questions

- Is a small directory distribution an honest product fit, or is one file
  genuinely important?
- Which target should define the minimum compatible Linux environment?
- Which files in the assembled distribution surprise you?

<details>
<summary>Hint 1</summary>

Separate "embedded executable" from "portable distribution" in your mental
model.
</details>

<details>
<summary>Hint 2</summary>

Compare what `raco exe` creates with what `raco distribute` adds around it.
</details>

<details>
<summary>Hint 3</summary>

The checked-in build harness already creates and smoke-tests the seed archive;
inspect its evidence before changing it.
</details>

### Reflect

Record whether distribution feels pleasant enough to justify the language
work, plus any target you would add or drop.

## Mission 1 — language entry

### Outcome

Accept one existing `.mar` file through a Marionette reader while preserving
the current non-S-expression surface.

### Invariants

- Existing single-file source remains readable without a mandatory rewrite.
- The reader retains source identity and positions.
- Reading does not resolve files, run graph rules, or mutate global state.
- A malformed phase header fails at the location the reader actually saw.

### Finish condition

The smallest fixture can be read both through the CLI path and through the
language entry mechanism you choose; one malformed fixture reports its source
path and exact range.

### Design questions

- Should `#lang marionette` be required, optional, or a wrapper used only by
  Racket tooling?
- What belongs in `read-syntax`, and what would make the reader too clever?
- Which parts of the line-oriented syntax deserve a real grammar now?

<details>
<summary>Hint 1</summary>

Treat source locations as data you cannot reconstruct later.
</details>

<details>
<summary>Hint 2</summary>

Explore syntax objects and source locations before choosing an AST shape.
</details>

<details>
<summary>Hint 3</summary>

Compare a `syntax/module-reader` language with a programmatic reader used by
the CLI; write down which compatibility promise each makes easier.
</details>

### Reflect

Record the entry mechanism you chose and one alternative you rejected.

## Mission 2 — source model

### Outcome

Turn the smallest useful plan into a source AST that can survive imports and
rich diagnostics.

### Invariants

- Surface declarations and the closed trajectory graph are different types.
- Every declaration and reference can name its source span.
- Paths and comments do not become semantic identity.
- Duplicate definitions remain representable long enough to diagnose both
  sites.

### Finish condition

A black-box snapshot for the smallest plan contains the expected declarations
and spans, and a duplicate declaration diagnostic points at both definitions.

### Design questions

- Which distinctions in the source deserve separate variants?
- Where will names become resolved identities?
- What should stay as syntax objects, and what should become plain immutable
  values?

<details>
<summary>Hint 1</summary>

Model what the author wrote before modelling what the runtime needs.
</details>

<details>
<summary>Hint 2</summary>

Try drawing the lifetime of a name from token, to declaration, to linked
identity, to trajectory id.
</details>

<details>
<summary>Hint 3</summary>

Issue #32 lists the diagnostics that collapse if the model retains only
`file + line`.
</details>

### Reflect

Record the smallest AST choice you are happy to evolve rather than defend.

## Mission 3 — fixed-point graph semantics

### Outcome

Ask one terminating graph question about a cyclic plan through Racket Datalog.

### Invariants

- The result is independent of fact insertion order.
- The cyclic fixture terminates.
- The relation expresses a Marionette claim, not a reproduction of SWI syntax.
- Any Racket callback used from Datalog has an explicit termination argument.

### Finish condition

The selected graph conformance case returns the same structured finding set as
the reference oracle, including diagnostic code and entity location.

### Design questions

- Which relations really need fixed-point closure?
- What is the smallest fact vocabulary that keeps the rule readable?
- Which deterministic checks would be clearer as ordinary Racket?

<details>
<summary>Hint 1</summary>

Start with reachability, not with the entire validation rulebase.
</details>

<details>
<summary>Hint 2</summary>

Use an immutable input fact set and make the query result an ordinary Racket
value.
</details>

<details>
<summary>Hint 3</summary>

Racket's Datalog interoperability API exposes a theory value; one theory per
query boundary is easier to reason about than shared mutable state.
</details>

### Reflect

Record why the chosen relation belongs in Datalog and name one relation that
does not.

## Mission 4 — one excellent diagnostic

### Outcome

Render one representative compiler failure with an exact primary span, useful
help, and enough provenance to understand its source.

### Invariants

- Diagnostic data is structured before it is rendered.
- Plain and JSON forms describe the same finding.
- Colour is presentation only.
- The source registry is invocation-scoped; source text is not embedded in the
  trajectory.

### Finish condition

The undefined-target fixture underlines only the target token and emits a
stable machine code. A snapshot test covers plain output and a structural test
covers JSON.

### Design questions

- What is the minimum useful span type?
- How will a semantic entity map back to source after lowering?
- Which wording may evolve without breaking consumers?

<details>
<summary>Hint 1</summary>

Design the JSON shape before tuning terminal decoration.
</details>

<details>
<summary>Hint 2</summary>

Keep notes, help, and replacement edits distinct even if only help is rendered
today.
</details>

<details>
<summary>Hint 3</summary>

Use the issue #32 example as an acceptance snapshot, not as an instruction for
your renderer internals.
</details>

### Reflect

Record the diagnostic fields you omitted and why the type can add them later.

## Mission 5 — one audited transition

### Outcome

Initialise one plan and take one permitted transition with the same externally
visible effect as the current walker.

### Invariants

- The graph hash binds state to the compiled trajectory.
- A successful operation appends exactly one attributed log entry.
- A refused operation changes nothing.
- The transition is selected by exact choice identity, not by target phase.
- The state shape can grow into distinct `@ask`, `@input`, and `@human`
  interactions without treating a display label as authority.

### Finish condition

One versioned autonomous walker conformance vector passes unchanged for
TypeScript and Racket output. Full interaction and persistence parity is
explicitly post-slice; do not squeeze it into this mission.

### Design questions

- Which part of the effect is a pure state transition?
- Where do time, persistence, and identity enter the boundary?
- How can refusal codes remain stable while messages improve?

<details>
<summary>Hint 1</summary>

Separate computing an effect from committing an event.
</details>

<details>
<summary>Hint 2</summary>

Treat the conformance JSON as the public protocol and the existing state class
as one implementation.
</details>

<details>
<summary>Hint 3</summary>

The baseline and resolution conformance cases are narrower entry points than
the runtime-process suite.
</details>

### Reflect

Record where purity ends in your walker design.

## Mission 6 — composition

### Outcome

Resolve one imported fragment through a module design that can grow into issue
#32 without textual inclusion.

### Invariants

- The caller chooses where a fragment enters and where its named exits go.
- Definitions are private unless deliberately exported.
- Relative paths resolve from the importing source.
- Linking produces one closed graph; the runtime never loads modules.
- Reusing a stateful fragment cannot silently collide with its first instance.

### Finish condition

A split plan links to the same semantic graph as its single-file form, and one
nested error retains both its primary span and import trace.

### Design questions

- Is the source concept `use`, `import`, or something else?
- Is each use an instance, a namespace binding, or both?
- What does `END` mean inside a fragment?
- How much of Racket's module system should be visible to `.mar` authors?

<details>
<summary>Hint 1</summary>

Draw the call site before inventing the declaration syntax.
</details>

<details>
<summary>Hint 2</summary>

Name an entry and two exits in prose, then search for the least punctuation
that keeps the wiring obvious.
</details>

<details>
<summary>Hint 3</summary>

Try lowering qualified local identities into stable opaque trajectory ids only
after all caller wiring is resolved.
</details>

### Reflect

Record the shortest realistic import example and the collision rule it implies.

## Mission 7 — the real release

### Outcome

Replace the seed payload with the vertical slice and publish the same
self-contained archives.

### Invariants

- CI and local packaging use the same build entry point.
- The unpacked executable reads a fixture without a language runtime present.
- Artifact names identify version and target.
- Release contents include licence and provenance.

### Finish condition

At least two target archives run the slice's reader, diagnostic, graph query,
transition, and import smoke cases after unpacking.

### Design questions

- Did any runtime dependency escape the distribution?
- Is startup time acceptable for extension-driven use?
- Which provenance belongs inside an archive versus in release metadata?

<details>
<summary>Hint 1</summary>

Re-run the seed's clean-machine smoke test unchanged before expanding it.
</details>

<details>
<summary>Hint 2</summary>

Inspect dynamic library references on each operating system when an archive
works on CI but not on another clean machine.
</details>

<details>
<summary>Hint 3</summary>

Keep platform assembly native until cross-compilation has demonstrated a real
maintenance advantage.
</details>

### Reflect

Record sizes and timings beside the seed measurements and explain the change.

## Mission 8 — continue, revise, or stop

### Outcome

Make an evidence-backed decision about the complete Racket port.

### Invariants

- A failed experiment is recorded rather than hidden.
- Language ergonomics and distribution ergonomics are evaluated separately.
- No consumer migrates before the required parity boundary is agreed.
- Imports and rich diagnostics are implemented once, in the chosen frontend.
- A successful slice is not described as runtime or Pi parity.

### Finish condition

Write a short decision record answering:

1. What felt natural in Racket?
2. What fought the host or its distribution model?
3. Which semantics should use Datalog, Racklog, or ordinary Racket?
4. What must the full parity window include for interactions, amendments,
   persistence and host adapters?
5. Should the project continue, revise the experiment, or stop?

### Design questions

- Would you choose the same representations after the slice?
- Which part of the current TypeScript architecture should not survive?
- Is the thin npm adapter still justified by Pi, and when can it disappear?

<details>
<summary>Hint 1</summary>

Compare decisions and evidence, not line counts.
</details>

<details>
<summary>Hint 2</summary>

Separate "Racket was unfamiliar" from "Racket made the product worse."
</details>

<details>
<summary>Hint 3</summary>

Use `plans/racket-port.mar` to record the human decision; do not let a green
demo silently become a production cutover.
</details>

### Reflect

The decision record is the reflection. Bring it to the `vertical_slice`
operator checkpoint.

## After the slice — required before cutover

If the experiment continues, port one coherent family at a time and advance
the pinned oracle only after reviewing the reference delta:

1. Complete parser, linker, diagnostics and graph-rule parity, including issue
   #32's imports and source provenance.
2. Complete walker parity for operator `@ask`, agent-opened `@input`, evidenced
   `@human`, observations, timeouts and legacy spec-0.5 replay.
3. Implement future-only amendments: frozen completed contracts, exact open
   input edges, graph epochs, pure validation and atomic stale-write refusal.
4. Implement the versioned NDJSON runtime, receipts, projections, event replay,
   persistence recovery and executor-complete work-packet data.
5. Run the thin TypeScript adapter against release binaries. Preserve atomic
   draft validation, review artifacts, standard/stacked worktree metadata, Git
   identity, generic work packets, bounded approval prompts and concise visible
   results with complete structured details kept out of transcript rendering.
6. Remove TypeScript/SWI semantics only after the agreed differential window;
   never ship a silent fallback interpreter.

The core parity packet in `spec/parity/` is a starting seam, not proof of all
six items. Existing runtime, amendment and Pi integration tests remain required
until equivalent process-level conformance vectors replace them.

## Reference shelf

- [Custom `#lang` readers](https://docs.racket-lang.org/guide/hash-lang_reader.html)
- [Syntax objects](https://docs.racket-lang.org/guide/stx-obj.html)
- [Racket Datalog](https://docs.racket-lang.org/datalog/)
- [Datalog interoperability](https://docs.racket-lang.org/datalog/interop.html)
- [Racklog](https://docs.racket-lang.org/racklog/)
- [`raco exe`](https://docs.racket-lang.org/raco/exe.html)
- [`raco distribute`](https://docs.racket-lang.org/raco/exe-dist.html)
- [`raco cross`](https://docs.racket-lang.org/raco-cross/)
- Marionette issues [#33](https://github.com/leemeichin/marionette/issues/33)
  and [#32](https://github.com/leemeichin/marionette/issues/32)
- Existing contracts in `../spec/` and conformance vectors in
  `../spec/conformance/`
