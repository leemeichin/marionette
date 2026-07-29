# Marionette for Racket

This directory is a clean-room seed for the learning-first Racket port tracked
by [issue #33](https://github.com/leemeichin/marionette/issues/33). The
TypeScript/SWI implementation one directory up remains the reference
implementation until the migration plan reaches its cutover gate.

The seed deliberately contains:

- package metadata and test commands;
- a trivial executable entry point;
- a load check for Racket's Datalog and Racklog libraries;
- empty boundaries for the human-owned reader, source model, semantics, and
  walker;
- the outcome-based [48-hour workbook](WORKBOOK.md).

It deliberately does not contain a Marionette parser, AST, rule port, walker,
or import implementation.

## Seed commands

With Racket 9.2 installed:

```console
raco pkg install --auto --name marionette-racket ./racket
raco test -p marionette-racket
racket racket/marionette/main.rkt --version
```

Build and assemble a self-contained local distribution:

```console
racket racket/scripts/build-distribution.rkt \
  --target "$(racket -e '(display (system-library-subpath #f))')" \
  --version 0.0.0-bootstrap
```

The build script writes an archive and a JSON evidence file under
`racket/artifacts/`. CI repeats the build on each supported native runner and
smoke-tests the unpacked result without invoking Racket.

## Boundary

The intended long-lived shape is one authoritative Racket executable. The npm
package remains temporarily because Pi loads TypeScript extensions; it should
become a thin adapter that locates the right platform artifact and speaks the
binary's versioned protocol. It must not retain a second parser, rule engine,
or walker after cutover.
