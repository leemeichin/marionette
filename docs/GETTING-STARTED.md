# Getting started: install the skills and start dogfooding

Everything you need to author your first trajectory and record the Phase 1
success metric. Three pieces: the **CLI** (compiler/validator), the
**authoring skill** (teaches Claude to draft plans that compile), and the
**execution skill** (teaches Claude to traverse a compiled plan: ingest the
work packet, do the work, record decisions, escalate at `@human` — see
[`EXECUTION.md`](EXECUTION.md)). The plugin route installs both skills; the
copy route works the same with `marionette-execution` in place of
`marionette-authoring`.

## 1. Install the CLI

Pick one:

```console
# a) Global command from a clone (recommended while developing marionette itself)
$ git clone https://github.com/leemeichin/marionette && cd marionette
$ npm install && npm link          # installs deps, builds, puts `marionette` on PATH
$ marionette version

# b) Zero-clone, from anywhere (npm builds it transparently on first use)
$ npx --yes github:leemeichin/marionette validate plan.mar
```

Both are verified working. `npm link` is nicer for repeated use; `npx` is fine
for trying it out or CI.

## 2. Install the authoring skill

Three routes, by situation:

- **Inside this repo:** nothing to do — sessions here pick it up from
  `.claude/skills/` automatically.
- **All your Claude Code sessions (plugin, recommended):** this repo is a
  single-plugin marketplace. In any Claude Code session:

  ```
  /plugin marketplace add leemeichin/marionette
  /plugin install marionette@marionette
  ```

  The skill becomes available (namespaced) in every project.
- **Personal skill (copy):**

  ```console
  $ mkdir -p ~/.claude/skills/marionette-authoring
  $ curl -fsSL https://raw.githubusercontent.com/leemeichin/marionette/main/skills/marionette-authoring/SKILL.md \
      -o ~/.claude/skills/marionette-authoring/SKILL.md
  ```

  Note for claude.ai/code **web/cloud sessions**: they don't read
  `~/.claude/skills` from your machine — enable personal skills in your
  claude.ai skill settings (Customize) instead, or use the plugin route.

## 3. Author your first plan (the dogfood protocol)

This is how we measure the Phase 1 bar (*first-session compile success ≥70%*,
tracked in [#2](https://github.com/leemeichin/marionette/issues/2)):

1. Open a **fresh session** in any project with the skill installed.
2. Give it real notes, e.g.:

   > Use marionette-authoring. Plan this for me: we're migrating the billing
   > service off Stripe Classic. Spike the new API first — if metered billing
   > isn't supported we stay put. Up to two spike attempts. Finance signs off
   > before any customer is switched, and we roll back if error rates spike.

3. The skill drafts `plan.mar`, runs `marionette validate --strict`, fixes
   diagnostics (one revision loop), and shows you the Mermaid render +
   plain-language summary with every `@human` checkpoint called out.
4. **Record the data point**: did the first validate pass have zero errors?
   Drop a one-line comment on
   [#2](https://github.com/leemeichin/marionette/issues/2) —
   `session N: first-pass ✅/❌ (defect codes if any)` — the skill reports
   this at the end of each run.
5. Review honestly against G3: can you read the render cold in <5 minutes?

After ~5 sessions, advance Marionette's own plan accordingly (from this repo):

```console
# bar met (≥70%):
$ marionette state choose plans/marionette.mar 0 --actor <you> \
    --rationale "N of M first-session compiles clean"
# below the bar — loop and iterate on the skill:
$ marionette state choose plans/marionette.mar 1 --actor <you> \
    --rationale "only N of M clean; failure modes: ..."
```

## 4. Traverse a plan of your own

```console
$ marionette state init plan.mar        # binds plan.state.json to the compiled hash
$ marionette brief plan.mar             # work packet: phase, refs, choices, escalation
$ marionette state show plan.mar        # current phase, variables, available choices
$ marionette state choose plan.mar 1 --actor agent --rationale "why"
$ marionette state advance plan.mar --actor agent   # follow a fallthrough divert
$ marionette state rebind plan.mar      # after editing a live plan: migrate, keep the log
$ marionette render plan.mar            # Mermaid, with taken path + frontier highlighted
```

Rules the walker enforces: `@human` choices refuse `--actor agent` (that's
the escalation boundary working); every choice requires `--rationale`;
editing the plan after `state init` trips drift detection (exit code 3) and
asks you to reconcile via `state rebind` — that's by design, not breakage.
To hand the traversal to an agent, use the execution skill: it loops on
`marionette brief --json`, honours the plan's `# delivery:`/`# report:`
config, and escalates `@human` checkpoints instead of taking them.

## 5. When something feels wrong

That's the dogfood signal we want. File it on the repo — tag the issue with
the plan node it relates to if applicable (`# github:issue:` in
`plans/marionette.mar` shows the mapping pattern).
