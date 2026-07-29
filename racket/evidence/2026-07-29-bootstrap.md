# Racket bootstrap distribution evidence

Source: PR [#34](https://github.com/leemeichin/marionette/pull/34),
Actions run
[`30491077877`](https://github.com/leemeichin/marionette/actions/runs/30491077877).
The evidence files identify the PR merge commit
`bccd3410d19f5116e2bde70976756b24f8848f72`; the corresponding branch commit
is `c4e748f`.

Each native job installed Racket 9.2, installed and tested the local package,
built an executable with `raco exe`, assembled it with `raco distribute`,
archived it, unpacked that archive into a clean temporary directory, and ran
the unpacked `marionette --version` without invoking Racket.

| Target | Archive | Build | Seed startup |
| --- | ---: | ---: | ---: |
| `x86_64-linux` | 15.00 MiB | 23.58 s | 286 ms |
| `aarch64-linux` | 14.56 MiB | 25.20 s | 277 ms |
| `aarch64-macos` | 14.94 MiB | 3.54 s | 176 ms |

The macOS archive contains one embedded executable plus the seed documentation.
Linux archives contain the executable and a `lib/plt/racketcs-9.2` runtime.
All three include `README.md` and `DISTRIBUTION.md`.

The PR workflow retains each archive and its machine-readable evidence JSON as
an Actions artifact. A `racket-v*` tag runs the same matrix and the publish job
attaches the downloaded matrix artifacts to a generated GitHub release. The
tag-only write path has not been exercised because this evidence run is a pull
request, not a release.

## Local observations

- Racket 9.2 on native `aarch64-darwin`, supplied by Nix, passes both package
  tests and loads Datalog and Racklog.
- That Nix build reports itself as a cross installation and fails inside
  `raco distribute` while patching an executable. The official Racket
  installers used on all three Actions runners assemble successfully, so this
  is currently classified as a Nix packaging incompatibility rather than a
  Racket distribution failure.
- The official `racket/racket` Docker images are amd64-only. Racket aborts in
  Chez Scheme's `petite` layer under this Apple Silicon Docker emulation, so
  Docker is not a useful local fallback on this machine.

## Gate notes

- A roughly 15 MiB download and 60–63 MiB unpacked seed distribution is small
  enough to continue the experiment.
- Linux's two-file runtime layout is acceptable under the stated
  self-contained-directory requirement; a literal one-file executable remains
  a stretch goal.
- Before a non-experimental release, add the repository's canonical licence
  text and the redistribution notices identified in `DISTRIBUTION.md`.
- Decide whether official Racket installers are the supported local packaging
  route or whether the Nix `raco distribute` incompatibility deserves a
  separate fix.
