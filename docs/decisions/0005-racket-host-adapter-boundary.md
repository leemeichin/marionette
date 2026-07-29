# ADR-0005: keep a thin TypeScript host adapter around one Racket interpreter

- Status: Proposed; activation is gated by the Racket vertical slice
- Date: 2026-07-29
- Issues: [#33](https://github.com/leemeichin/marionette/issues/33),
  [#32](https://github.com/leemeichin/marionette/issues/32)

## Context

Marionette is currently one npm package containing the TypeScript compiler,
walker, CLI, Pi extension, packaged skills, and embedded SWI-Prolog rule
engine. The Racket experiment aims to move the language, semantics, state
protocol, persistence, and CLI into a self-contained executable.

Pi still loads extensions from TypeScript, and `pi install
git:github.com/leemeichin/marionette` is a useful installation surface.
Removing npm immediately would make the language migration unnecessarily
coupled to Pi's extension mechanism. Keeping the current TypeScript
interpreter indefinitely would create two semantic authorities and undermine
the parity boundary.

## Decision

After cutover, the Racket executable is the only production interpreter.

The `marionette` npm package remains temporarily as a host adapter and
distribution shell. It may:

- locate the correct executable for the current platform;
- verify that its protocol and version are compatible;
- spawn one-shot CLI commands;
- own the long-lived child process used by the Pi extension;
- translate Pi tool calls and trusted human responses to the versioned NDJSON
  runtime protocol;
- surface process lifecycle, stderr diagnostics, and structured protocol
  errors;
- package the authoring and execution skills.

It must not contain or fall back to:

- a `.mar` parser or compiler;
- graph validation or Prolog/Racket rules;
- expression evaluation;
- walker state transitions or refusal precedence;
- an independent trajectory hash implementation;
- a second persistence format.

Before cutover, an explicit development switch may select the candidate binary
for differential testing. After cutover, failure to find or start the binary
is an actionable installation error, not permission to run the retired
TypeScript semantics.

## Executable resolution contract

The adapter resolves one executable in this order:

1. an explicit development or managed-install override;
2. a package-local, versioned platform distribution installed from a release
   artifact;
3. an error naming the unsupported target, expected version, and repair
   command.

The exact npm distribution mechanism can evolve without changing the adapter:

- registry releases may use platform-specific optional packages;
- Pi's Git-based install may fetch and verify the matching GitHub release in
  its existing prepare step;
- development and Nix packaging may provide an explicit executable path.

Every route ends at the same resolver and checks a release manifest or digest.
There is no network access when the installed command is run.

The initial target vocabulary is:

| Adapter target | Release artifact |
| --- | --- |
| `darwin-arm64` | `aarch64-macos` |
| `linux-arm64` | `aarch64-linux` |
| `linux-x64` | `x86_64-linux` |

Unsupported operating systems fail clearly until their native artifact joins
the release matrix.

## Protocol boundary

The existing runtime process protocol is the primary integration seam. Racket
must implement its versioned initialize/next/choose/advance/observe/record/
events surface and machine refusal codes before the Pi adapter migrates.

One-shot compiler and presentation commands need a similarly structured
process contract. Human-readable stdout/stderr remains for terminal use, but
the adapter consumes JSON rather than scraping rendered prose.

The current exported in-process TypeScript semantic API is deprecated at
cutover. Compatibility helpers may invoke the executable asynchronously, but
the project will not preserve a synchronous or object-identical façade at the
cost of duplicating the implementation. That API change belongs in the
cutover release notes.

## Consumer migration

### Pi extension

Keep the TypeScript extension and its trusted host UI. Replace imports of
compiler, rule, state, and runtime modules with a small process client. Contract
tests exercise the client first against a fake protocol process, then against
each release binary.

### Skills

Keep the packaged Markdown skills. Their CLI resolution wording remains valid;
once the package's `bin/marionette.js` becomes a launcher, the skills reach
Racket without embedding language-specific instructions.

### Command line

The npm `marionette` bin becomes a launcher for the bundled platform
distribution. Direct archive users run the Racket executable without Node.

### Browser demo

The browser demo is not on the production cutover path. Freeze it on the final
TypeScript compiler with a visible compatibility-snapshot label, or switch it
to precompiled examples. A hosted compiler or Racket/WASM experiment is a
separate decision.

## Migration sequence

1. TypeScript/SWI remains authoritative while Racket emits parity packets.
2. The adapter gains an explicit opt-in Racket backend for differential and
   integration tests.
3. A human confirms the required parity window and release evidence.
4. The package defaults to the Racket executable.
5. TypeScript compiler, rule, and walker modules are removed in the same
   release; no silent fallback remains.
6. The wrapper can be retired later if Pi accepts native executable extensions
   or another host owns the process integration.

## Consequences

- Pi and npm users keep a familiar installation and extension surface.
- Direct binary users need neither Node nor npm.
- One semantic authority makes diagnostic, hash, and refusal parity
  enforceable.
- The adapter adds release-resolution and child-process lifecycle work.
- Platform artifacts become part of npm/Git installation reliability.
- Some existing library consumers will need an asynchronous process API or a
  direct binary integration.

## Deferred decisions

- optional platform npm packages versus verified GitHub-release download;
- the exact one-shot JSON command envelope;
- Windows support and archive format;
- when Pi no longer requires the TypeScript host adapter.
