# ADR-0002: Implementation language — TypeScript now, contract-first portability later

**Status:** Accepted · **Date:** 2026-07-23 · **Relates to:** ADR-0001

## Context

Question raised in review of the Phase 1 toolchain: should Marionette be
written in Go for the sake of shipping a simple static binary?

## Considerations

**For Go:** single static binary; trivial distribution and CI caching; a good
fit for a standalone CLI; no Node runtime prerequisite.

**Against, for Phase 1 specifically:**

1. **The Phase 1 deliverable is a skill, not a binary.** Per PRD §9, Phase 1
   ships "SKILL.md + validator script" running inside agent environments and
   CI — places where Node is already the substrate. Nobody installs a binary
   in this phase.
2. **The compiler already exists.** ~2k lines of zero-dependency TypeScript
   with a 50-test suite (golden files per construct, a fixture per defect
   class). A port re-spends that effort and delays dogfooding (G5) for no
   Phase 1 benefit.
3. **Ecosystem adjacency.** Mermaid tooling, JSON Schema validation, future
   editor support (an LSP server is naturally TS), and the Phase 2 pi-agent
   proving ground all sit in the JS/TS ecosystem.
4. **If ADR-0001 had gone the other way, Go would be ruled out anyway:**
   maintained Ink runtime ports exist for C#, JS, Java and Rust — not Go.

**Binary story without a rewrite:** `bun build --compile` or `deno compile`
produce self-contained executables from the existing TypeScript when
distribution needs one; that becomes a CI artifact the day there is a
consumer for it.

## Decision

Phase 1 stays TypeScript. The **trajectory JSON schema — not the codebase —
is the portability boundary** (PRD §2, design decision 5): it is deliberately
language-neutral, so a Go (or Rust) implementation of the Phase 2
*runtime/walker* — the piece that actually benefits from being a small static
binary dropped into arbitrary environments — can be written against
`spec/trajectory.schema.json` without ever porting the compiler. Conformance
tests for the walker (issue #3) should be written runtime-agnostically to
keep that door open.

## Revisit trigger

At the Phase 2 boundary, if the runtime needs embedding in environments where
Node is unacceptable — or if dogfooders ask for `brew install marionette` —
evaluate: (a) bun/deno-compiled binary of the existing code, then (b) a Go
walker against the schema. A Go *compiler* port is last resort, justified
only by real distribution pain.
