# Marionette docs site

A dependency-free static site: full-viewport terminal aesthetic, interactive
demos replayed from **verbatim captures of the real CLI**, held to WCAG AA
by build-time gates. Design rationale and tokens: [`DESIGN.md`](DESIGN.md).

## Develop

```console
$ cd docs-site
$ npm run build      # src/pages/*.html + transcripts/ → dist/
$ npm run check      # contrast AA + transcript fidelity + a11y structure
$ npm run preview    # http://localhost:8788
```

No dependencies to install; the build is plain Node (≥ 18).

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
- `/playground` compiles and walks plans **in the browser** using the repo's
  own tsc output (staged into `dist/lib` by the build — run `npm run build`
  at the repo root first). Hashing is WebCrypto (`globalThis.crypto`), the
  same code path on Node ≥ 20 and browsers — no shims. Three.js is vendored
  under `public/vendor/` and loaded only on that page.
- `<mar-file src="checkout.mar">` / `<mar-src>…</mar-src>` render
  syntax-tinted `.mar` sources.

Accessibility is enforced, not aspirational: `npm run check` fails on any
AA contrast regression, unlabelled control, missing landmark/skip link, or
transcript drift. Demos never autoplay, are fully keyboard operable, and
collapse to an instant reveal under `prefers-reduced-motion`.
