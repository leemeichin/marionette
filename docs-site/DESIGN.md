# Docs-site design system

Marionette's docs separate two modes that the old design treated as one:
**reading** and **doing**. Explanations use a calm, spacious documentation
layout; plans, commands and real CLI captures retain the terminal character.
Accessibility remains a build gate rather than a visual variant.

## Principles

1. **Readable before technical.** System sans-serif type, a 47rem reading
   measure, generous section spacing and clear headings carry long-form copy.
   Monospace is reserved for plan syntax, commands, machine output and compact
   navigation labels.
2. **Progressive examples.** A one-stage hello-world plan comes first, then a
   two-stage issue-to-PR loop, then checkout and production-scale examples.
   Reference density never has to be the reader's entry point.
3. **Terminal-true.** Recorded terminal output is captured from the real CLI,
   with ANSI bytes mapped to CSS tokens. It is not edited into a mock-up.
4. **Dependency-free highlighting.** Static shell, JSON and `.mar` examples
   are highlighted at build time. Live `.mar` editors use an inert highlighted
   mirror beneath the real textarea, preserving native editing and assistive
   technology behaviour.
5. **Plain language, precise contracts.** The UI and compiled contract call
   `-> target` an “automatic next step”; its JSON field is `next`.
6. **Progressive enhancement.** Pages remain complete static HTML. JavaScript
   adds copy controls, syntax colouring in editable fields, transcript replay
   and the in-browser compiler/walker.

## Visual system

The light theme is cool paper with indigo, emerald, raspberry, amber and
azure accents. Dark mode is deep indigo-navy with brighter versions of the
same colours. Theme tokens live in `public/tokens.css`; the contrast build
checks every semantic foreground on all three solid backgrounds in both
themes at WCAG AA (4.5:1 or higher).

Body text uses the native UI sans stack at `17px / 1.72`. Code uses the
native monospace stack at `13–14px / 1.6`. Nothing external is fetched, so
there is no font-loading delay or tracking surface.

The desktop canvas is at most 96rem wide:

- 17rem documentation rail;
- up to 75rem for the page;
- 47rem for prose;
- the full page width for examples, transcripts and reference tables.

At 58rem the rail becomes a horizontally scrollable section bar. Interactive
two-pane examples stack vertically. The layout holds at 320px and under
200% zoom without page-level horizontal scrolling.

## Interaction and accessibility

- One header, site navigation, main and footer landmark per page.
- A skip link is the first focusable control.
- Every interactive element uses a visible 3px focus ring.
- Transcript playback is opt-in; reduced-motion users get the final frame.
- Full transcript text exists in the DOM from first render. Replay only
  changes visibility, so screen readers are not flooded with live lines.
- The editor mirror is `aria-hidden`; the native textarea remains labelled,
  selectable and keyboard-operable.
- Syntax colour is redundant. Tokens remain understandable from punctuation
  and words, and every colour pair passes the contrast gate.
- Copy buttons are enhancements. If clipboard access fails, the code is
  selected for the user.

## Enforcement

`npm run check` runs:

1. token contrast across both themes;
2. byte fidelity for every recorded CLI transcript;
3. structural HTML checks for landmarks, titles, one `h1`, labels, focusable
   overflow regions, image alternatives and current-page navigation.

The home playground and example mini-playgrounds run the repository's real
compiled compiler and walker. The 3D graph is decorative; the DOM controls
below it are the complete accessible interface.
