# Tracker sync: Jira, Linear, GitHub Issues

Nobody trusts a plan they can't see in their tracker. Sync connects a `.mar`
plan to the team's issue tracker in both directions — **without Marionette
ever owning a tracker connection**. The division of labour:

- **Marionette computes.** `marionette sync` emits a deterministic,
  provider-neutral *manifest* of what should exist on the tracker (issues to
  create, decisions to mirror as comments, issues to close), plus the
  mechanical write-back commands that record results in the plan.
- **The agent's own capabilities execute.** Whatever tracker tooling is in
  the executing agent's context — a GitHub MCP server, a Jira/Linear skill,
  a CLI — applies the manifest. No tool for the bound tracker in context
  means *report that to the user*; Marionette has nothing to configure,
  no credentials to hold, and nothing to fabricate.

Both directions rest on the existing metadata vocabulary
([`EXECUTION.md`](EXECUTION.md)): refs stay *references*; sync is a
computed diff against them.

## Binding a tracker (and remembering it)

A plan declares its tracker once, in the preamble:

```
# tracker: github            // or jira, linear
# github:repo: acme/platform // the provider context refs resolve against
```

When `# tracker:` is absent, sync infers the binding if exactly one provider
has any presence in the plan (context tags or refs). Anything else is
**ambiguous by design** — the manifest reports `tracker: null` with the
candidates, and the executor should ask the plan owner once, then record the
answer so the question never comes up again for this repo:

```console
$ marionette sync bind plan.mar --tracker jira
```

`sync bind` is a mechanical preamble edit: it recompiles, refuses to write a
broken plan, and rebinds live state automatically. The binding is versioned
with the plan — that *is* the memory.

`# tracker:` is not new syntax: it is the same namespaced `# key: value`
metadata that carries `# project:`, the ref namespaces and the delivery
config, with the same conventions (see the metadata table in
[`DSL.md`](DSL.md)) — and two rules of its own, both compiler-checked
(`MAR020`):

- **Plan-level only.** One tracker per plan; unlike `# delivery:`/`# report:`
  there is no node-level override, and a `# tracker:` tag inside a phase
  warns and has no effect.
- **Known values only.** Anything other than `github`, `jira` or `linear`
  warns (case-insensitive; repeated tags follow the standard last-occurrence-
  wins rule).

## Direction 1: tracker → plan (`marionette import`)

You already have a backlog and want Marionette to ingest it. The agent
fetches issues with its own tools and hands them over as neutral JSON:

```json
{
  "tracker": "github",
  "context": "acme/platform",
  "project": "q3_backlog",
  "issues": [
    { "id": 12, "title": "Fix login redirect" },
    { "id": 14, "title": "Add SSO support" }
  ]
}
```

```console
$ marionette import issues.json -o plan.mar            # queue mode (default)
$ marionette import issues.json --mode phases -o plan.mar
```

The scaffolder is deterministic and its output always compiles — importing a
backlog costs the model a JSON list, not hand-written DSL. Issue titles are
emitted so they can never inject DSL constructs.

### Queue mode: pulling issues in a loop, frugally

One phase, however long the backlog — token cost is O(1) in phase count:

```
# tracker: github
# github:repo: acme/platform
VAR remaining = 3

=== work_queue ===
Work the backlog one issue at a time: pick the next open item below, do the
work it describes, and record the outcome with an honest rationale.
- #12 Fix login redirect
- #14 Add SSO support
- #15 Rate limit the public API
# github:issue: 12, 14, 15
~ remaining -= 1
+ {remaining > 0} [Issue done, more remain] ~loop~ -> work_queue
* {remaining <= 0} [Backlog clear] -> END
```

The counter is monotonic, so the compiler *verifies* the loop is bounded
(zero warnings under `--strict`): exactly one iteration per issue, one
recorded rationale per iteration.

### The live-queue pattern (snapshot, drain, refresh)

When the total is not known until runtime, make the observation cadence part
of the plan. Fetch one count, drain that captured batch, then refresh:

```
VAR remaining: number = ?

=== triage ===
Fix the next item from the captured batch.
~ remaining -= 1
while {remaining > 0} -> triage
else -> refresh_queue

=== refresh_queue ===
Query the tracker once for the current open count.
? remaining
while {remaining > 0} -> triage
else -> harden
```

The initial late-bound declaration suspends traversal until the host supplies
the first count. The later `? remaining` refreshes only after the current
batch has been flushed, avoiding a tracker lookup and its context cost on
every item. Each observation records its source and each iteration records
the item handled. The mechanism is generic despite this tracker example: the
same form works for any externally measured scalar.

## Direction 2: plan → tracker (audit export)

Your immaculate plan should still show up where the team looks. The manifest
is the executor's to-do list:

```console
$ marionette sync plan.mar          # human summary
$ marionette sync plan.mar --json   # the machine manifest
```

Three op kinds, all deterministic:

| Op | When | Payload |
|---|---|---|
| `ensure-issue` | a phase has no issue ref for the bound tracker | title (phase title), body (prose + exits + provenance), and a `writeback` command |
| `comment` | a decision-log entry past the audit cursor exited a linked phase | the choice label, target, rationale, actor and timestamp |
| `close` | the plan completed and a visited phase is linked | a closing note |

Every op carries an `idempotencyKey` (`<hash12>:log:<n>`, `…:ensure:<phase>`,
`…:close:<phase>:<issue>`). The applying agent embeds the key in what it
posts (a trailing marker line) and skips ops whose key already appears —
so re-running sync never duplicates comments, whatever tool applies it.

After creating an issue, record it in the plan; after mirroring the log,
advance the cursor:

```console
$ marionette sync link plan.mar wrap_up 22     # → "# github:issue: 22" under the phase
$ marionette sync mark plan.mar                # cursor → end of the decision log
```

`sync link` edits the phase's metadata mechanically (recompile-checked,
state rebound), so the cross-reference lives in the diffable source, not in
a lookup table. `sync mark` writes the applied-through cursor to
`<plan>.sync.json` — commit that sidecar with the plan; `close` ops are
declarative ("ensure closed") and rely on the idempotency key instead of
the cursor.

## The executor's sync loop

1. `marionette sync <plan> --json`.
2. `tracker: null`? Ask the user which tracker, `sync bind`, re-run.
3. Apply `ops` with the tracker tools in context, embedding each
   `idempotencyKey`. No tools for that tracker? Report it; stop.
4. `sync link` for each created issue; `sync mark` once comments are posted.
5. Re-run at the cadence the plan's `# report:` config already prescribes
   (per-phase, at-checkpoints, or at-end).

## Runtime hosts and the event journal

For plans driven through `marionette start` ([`RUNTIME.md`](RUNTIME.md)),
the decision log and the run's append-only journal carry the same steps, so
a long-lived host can mirror continuously instead of by cursor-marking:
replay `events` after its own sequence cursor, apply the corresponding
`comment` ops, and journal the receipt with a `record` op
(`kind: "sync"`, the manifest's `idempotencyKey` as the record's
idempotency key). The CLI cursor flow and the journal flow are two views of
one stream — pick per host, don't mix both on the same run.

## What sync is not

- **Not a live connection.** Nothing polls, nothing webhooks. Sync runs
  when an executor runs it, and degrades to "here is what *would* sync".
- **Not bidirectional state.** Tracker-side edits (re-opened issues,
  changed titles) never mutate traversal automatically; the plan is the
  source of truth for structure, the tracker for conversation. A plan may
  request a typed runtime observation at an explicit `?` checkpoint, but
  the host performs and audits that lookup.
- **Not a substitute for refs.** `# github:issue:` etc. keep working as
  plain cross-references on plans that never sync.
