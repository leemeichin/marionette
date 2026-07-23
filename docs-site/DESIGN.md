# Docs-site design system

One aesthetic, held to one constraint: **the whole site is a terminal, and
accessibility is a compile error, not a variant.** Every token pair below is
checked programmatically against WCAG 2.x AA (≥ 4.5:1) by
`build/check-contrast.mjs`; the site build fails if a pair regresses.

## Principles

1. **Terminal-true.** Demo output is captured bytes from the real CLI
   (`transcripts/`), rendered by mapping ANSI SGR codes to token colors —
   never hand-drawn mock-ups. If the CLI doesn't print it, the site doesn't
   show it.
2. **Full-viewport tty, watercolour palette.** One monospace stack
   everywhere. The default theme is a cool paper-white with pastel accents;
   the dark theme is slate-blue with the same pastels. `prefers-color-scheme`
   is honoured, with a manual override persisted in `localStorage` and
   applied before first paint. No warm/olive cast anywhere.
3. **No decoration that costs legibility.** No scanlines, no glow, no CRT
   curvature, no typewriter sound. The aesthetic is carried by type, color
   and chrome (window title bars, prompt glyphs), all of which stay AA.
4. **Progressive enhancement.** Every page is complete, readable static HTML
   with no JavaScript. JS adds replay/interactivity to demos; without it the
   full transcript is simply visible.

## Tokens

Defined once as CSS custom properties in `public/tokens.css`, switched by
`[data-theme]` on `<html>` (and by `prefers-color-scheme` when unset).

| Token | Light (default, paper) | Dark (slate) | Role |
|---|---|---|---|
| `--bg` | `#f8fafc` | `#14171d` | page background |
| `--bg-elev` | `#eef2f8` | `#1b202a` | terminal chrome, panels, nav |
| `--bg-code` | `#f1f5fa` | `#212734` | code/transcript background |
| `--fg` | `#2c3644` | `#dee4ee` | body text |
| `--fg-dim` | `#51606f` | `#a3aebf` | ANSI dim, secondary text |
| `--fg-faint` | `#5c6a79` | `#96a1b2` | comments, metadata |
| `--green` | `#1e7566` | `#93d9b2` | ANSI green, success marks |
| `--red` | `#b04a5e` | `#f4a9b4` | ANSI red, errors |
| `--yellow` | `#7d661f` | `#e8d3a4` | ANSI yellow (warning bytes only — never decorative) |
| `--cyan` | `#22708a` | `#a1d6e8` | ANSI cyan, keywords, gates |
| `--magenta` | `#8b4d9e` | `#d8b6ec` | ANSI magenta, `@human` |
| `--accent` | `#1e7566` | `#93d9b2` | links, active nav, prompt `$`, phases |
| `--focus` | `#145c50` | `#aee8ff` | focus rings |

Verified: every foreground token ≥ 4.5:1 on every background token, both
themes (worst pair: light `--red` on `--bg-elev` at 4.69:1). The `.mar`
syntax tint uses only accent/cyan/magenta/green — yellow appears solely
when the CLI itself emitted a warning byte.

ANSI mapping: `31`→red · `32`→green · `33`→yellow · `35`→magenta ·
`36`→cyan · `1`→bold (weight 700, same color) · `2`→dim (`--fg-dim`).
Bold and dim never carry meaning alone; the CLI's own glyphs (`✓`, `✗`,
`error:`, `@human`) are the semantic channel, so color is redundant
reinforcement — safe for color-blind users.

## Type & spacing

- One stack: `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas,
  "DejaVu Sans Mono", monospace`. No webfonts; nothing to load or FOUT.
- Base `16px`; scale `0.8125rem` (fine print) · `1rem` (body & code) ·
  `1.25rem` (h3) · `1.5rem` (h2) · `2rem` (h1). Line-height `1.6` prose,
  `1.45` transcripts.
- Prose measure capped at `72ch`; transcripts scroll horizontally in their
  own `overflow-x: auto` container — the page never scrolls sideways.
- Spacing on an `0.5rem` grid (`--s1..--s6` = 0.5/1/1.5/2/3/4 rem).
- All sizes in `rem`; layout is flex/grid and holds from 320px up. Zoom to
  200% loses nothing (WCAG 1.4.4/1.4.10).

## Chrome

- Terminal windows: `--bg-code` panel, 1px `--bg-elev` border, a title bar
  showing the working file (e.g. `~/checkout — marionette`), and the demo
  controls. Decorative title-bar dots are `aria-hidden`.
- Prompts: `$ ` in `--accent`, user-typed command in `--fg` bold; output
  verbatim below.
- Navigation is a persistent left rail (top bar on narrow viewports) styled
  as a file listing; current page marked with `aria-current="page"` and an
  accent bar, not color alone.

## Interaction & accessibility rules

- **Landmarks:** one `<header>`, `<nav aria-label="Site">`, `<main>`,
  `<footer>` per page; skip-link as first focusable element; headings
  strictly nested; `<html lang="en">`.
- **Focus:** `:focus-visible` gets a 2px `--focus` outline with 2px offset,
  on every interactive element, both themes. No `outline: none` anywhere.
- **Keyboard:** demo players are plain `<button>`s (Play/Pause, Step,
  Skip-to-end, Restart) — tab-reachable, Enter/Space activated. No key
  traps; no custom widgets where a native element exists.
- **Motion:** replay animation is opt-in by pressing Play, streams
  line-by-line (no per-character flicker), and `prefers-reduced-motion:
  reduce` renders the final frame instantly — Play becomes "Show".
  Nothing auto-plays. No content flashes.
- **Layout stability:** a demo occupies its full-transcript height from
  first paint — collapsed lines keep their box (`visibility: hidden`, not
  `display: none`) and the controls row is reserved via a pre-paint `js`
  class — so playing, stepping and resetting never reflow the page
  (CLS ≈ 0, browser-verified).
- **Screen readers:** each demo is one region labelled by its step title.
  The transcript exists in the DOM as complete, ordered text from first
  render (players reveal, never re-create); live announcement is limited to
  a single polite status line ("playing… / done, 12 lines"), not the
  streamed lines themselves. ANSI color spans are plain `<span>`s —
  meaning never lives in color alone.
- **Theme toggle:** a labelled button (`aria-pressed`) in the header;
  respects `prefers-color-scheme` until the user chooses; choice persists.

## Enforcement

`npm run check` in `docs-site/` runs: token contrast (this file's table,
programmatically), transcript fidelity (every demo frame is a byte-exact
slice of `transcripts/*.txt`), and an HTML sanity pass (landmarks, skip
link, one `h1`, labelled buttons, `lang`, alt text).

## Playground

`/playground` runs the real compiler and walker in the browser: the tsc
output ships under `/lib` and runs unmodified — the compiler hashes with
WebCrypto (`globalThis.crypto.subtle`), the same code path on Node ≥ 20
and in browsers. The graph view is Three.js (vendored, loaded only on
that page). The
DOM controls are the accessible interface — the canvas is `aria-hidden`
garnish. Refusals are the walker's own (`human-checkpoint`, gate blocks,
once-exhaustion); nothing is simulated.
