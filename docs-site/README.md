# Marionette docs site

A static documentation site with a dependency-free build: a spacious reading layout,
syntax-highlighted live editors, and interactive demos replayed from
**verbatim captures of the real CLI**, held to WCAG AA by build-time gates.
Design rationale and tokens: [`DESIGN.md`](DESIGN.md).

## Develop

```console
$ cd docs-site
$ npm run build      # src/pages/*.html + transcripts/ → dist/
$ npm run check      # contrast AA + transcript fidelity + a11y structure
$ npm run check:browser # optional; needs Chrome and Node ≥ 22
$ npm run preview    # http://localhost:8788
```

Run `npm run build` at the repository root before building the site. The site
build is plain Node (≥ 18); the optional browser smoke test drives local Chrome.

## Deploy (Cloudflare)

The site ships as [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
— see `wrangler.jsonc`.

**CI (default):** `.github/workflows/deploy-docs.yml` deploys on every push
to `main` that touches `docs-site/` or `src/` (gates must pass first).
Secrets flow through 1Password:

- GitHub repo secret `OP_SERVICE_ACCOUNT_TOKEN` — a 1Password service
  account token with read access to the vault below.
- 1Password vault `marionette`: items named after the env vars
  (`CLOUDFLARE_API_TOKEN` — needs Workers Scripts:Edit — and
  `CLOUDFLARE_ACCOUNT_ID`), values in the `credential` field.

**Manually:** with a Cloudflare account and `wrangler` logged in:

```console
$ npm run deploy     # build + check + npx wrangler deploy
```

First deploy registers the `marionette-docs` worker; add a custom domain
from the Cloudflare dashboard afterwards if wanted.

## How content works

- `src/pages/*.html` — page fragments, wrapped by `src/layout.html`.
- `transcripts/` — pty captures of the real `marionette` CLI (`*.txt`,
  ANSI preserved), the demo plan sources (`*.mar`), and `manifest.json`
  (command line + exit code per capture). Regenerate by re-running the
  capture harness against a newer CLI, never by hand-editing.
- `<demo-cast id="06-state-init" title="…"></demo-cast>` in a page becomes
  an interactive terminal window replaying that capture. The fidelity check
  fails the build if rendered frames diverge from the capture by one byte.
- The home page (`/`) compiles and walks plans **in the browser** using the
  repo's own tsc output (staged into `dist/lib` by the build — run
  `npm run build` at the repo root first). The production Prolog semantics are
  embedded in that module graph and the self-hosted SWI-Prolog WASM runtime is
  staged with it; there is no runtime filesystem read or browser-only
  fallback. Hashing is WebCrypto
  (`globalThis.crypto`), the same code path on Node ≥ 20 and browsers. The
  graph is dependency-free SVG with pan, wheel/button zoom and a fit-to-view
  control.
- `<mini-playground src="checkout.mar" title="…">` embeds the same engine
  on the examples page as an editable two-pane widget (plan left, walk
  right), without the graph viewer — see `public/mini.js`.
- `<mar-file src="checkout.mar">` / `<mar-src>…</mar-src>` render
  syntax-tinted `.mar` sources. Static shell/JSON samples are highlighted
  by the zero-dependency build, and editable `.mar` fields use an
  `aria-hidden` highlighted mirror behind the native textarea.
- Old URLs (`/playground`, `/syntax`, `/walkthrough`, `/reference`) 301 to
  their new homes via `public/_redirects`.

Accessibility is enforced, not aspirational: `npm run check` fails on any
AA contrast regression, unlabelled control, missing landmark/skip link, or
transcript drift. Demos never autoplay, are fully keyboard operable, and
collapse to an instant reveal under `prefers-reduced-motion`.

`npm run check:browser` is the runtime gate: it loads the home playground and
examples in headless Chrome, waits for the real compiler/walker, takes a step
to `END` in each UI, and fails on browser exceptions.
