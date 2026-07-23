// Static site assembler. No dependencies: reads src/pages/*.html fragments,
// wraps them in src/layout.html, expands <demo-cast>, <mar-file> and
// <mar-src> elements from transcripts/, and writes dist/.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ansiLineToHtml, stripAnsi, escapeHtml } from './ansi.mjs';
import { highlightMar } from './mar-highlight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const transcripts = join(root, 'transcripts');

export const PAGES = [
  { slug: 'index', nav: 'readme', title: 'Marionette — compiled project trajectories for AI agents', desc: 'A plain-text trajectory language: humans author and gate the plan, a compiler proves it sound, an AI agent walks it.' },
  { slug: 'getting-started', nav: 'getting-started', title: 'Getting started — Marionette', desc: 'Install the marionette CLI and skills, write and validate your first plan.' },
  { slug: 'syntax', nav: 'syntax', title: 'Syntax reference — Marionette', desc: 'The .mar language: phases, choices, gates, loops, human checkpoints, variables, metadata.' },
  { slug: 'walkthrough', slugAliases: [], nav: 'walkthrough', title: 'Walkthrough — Marionette', desc: 'An end-to-end session: author a plan, fix compile errors, walk it with an agent, gate it as a human. Every frame is real CLI output.' },
  { slug: 'playground', nav: 'playground', title: 'Playground — Marionette', desc: 'Write a .mar plan, compile it in your browser with the real compiler, and step through the graph with the real walker.' },
  { slug: 'execution', nav: 'execution', title: 'Execution — Marionette', desc: 'How agents ingest and traverse a plan: state, briefs, escalation, drift and rebind, delivery metadata.' },
  { slug: 'examples', nav: 'examples', title: 'Examples & use-cases — Marionette', desc: 'Worked plans: product iteration loops, replatforms, and Marionette planning its own development.' },
  { slug: 'reference', nav: 'reference', title: 'CLI reference — Marionette', desc: 'Commands, exit codes, and the full compiler diagnostic table (MAR001–MAR019).' },
  { slug: '404', nav: null, title: 'Not found — Marionette', desc: 'No such page.' },
];

const manifest = JSON.parse(readFileSync(join(transcripts, 'manifest.json'), 'utf8'));
const manifestById = Object.fromEntries(manifest.map((m) => [m.id, m]));

function transcript(id) {
  return readFileSync(join(transcripts, `${id}.txt`), 'utf8');
}

// <demo-cast id="01-validate-broken" title="…"></demo-cast>
function renderDemo(id, title) {
  const meta = manifestById[id];
  if (!meta) throw new Error(`demo-cast: no transcript "${id}" in manifest`);
  const raw = transcript(id).replace(/\n$/, '');
  const lines = raw === '' ? [] : raw.split('\n');
  const exitCls = meta.exit === 0 ? 'ok' : 'err';
  const body = lines
    .map((l) => `<span class="t-line">${ansiLineToHtml(l)}</span>`)
    .join('');
  return `<section class="term" data-demo="${id}" aria-label="${escapeHtml(title)} (terminal session)">
<div class="term-bar"><span class="term-dots" aria-hidden="true">●●●</span><span class="term-title">${escapeHtml(title)}</span><span class="term-exit ${exitCls}">exit ${meta.exit}</span></div>
<div class="term-controls" hidden>
<button type="button" data-act="play">▶ play</button>
<button type="button" data-act="step">⇥ step</button>
<button type="button" data-act="skip">⏭ end</button>
<button type="button" data-act="restart">↺ reset</button>
<p class="term-status" role="status"></p>
</div>
<pre class="term-screen" tabindex="0" aria-label="terminal transcript (scrollable)"><code><span class="t-line t-cmd"><span class="t-prompt">$ </span>${escapeHtml(meta.cmd)}</span>${body}</code></pre>
</section>`;
}

// <mar-file src="checkout.mar" title="…"></mar-file>
function renderMarFile(file, title) {
  const source = readFileSync(join(transcripts, file), 'utf8');
  return renderMarBlock(source, title ?? file);
}

function renderMarBlock(source, title) {
  const bar = title
    ? `<div class="term-bar"><span class="term-dots" aria-hidden="true">●●●</span><span class="term-title">${escapeHtml(title)}</span></div>`
    : '';
  return `<div class="term">${bar}<pre class="term-screen mar" tabindex="0" aria-label="plan source (scrollable)"><code>${highlightMar(source)}</code></pre></div>`;
}

function expand(html) {
  html = html.replace(
    /<demo-cast id="([^"]+)" title="([^"]+)"><\/demo-cast>/g,
    (_, id, title) => renderDemo(id, title),
  );
  html = html.replace(
    /<mar-file src="([^"]+)"(?: title="([^"]+)")?><\/mar-file>/g,
    (_, file, title) => renderMarFile(file, title),
  );
  html = html.replace(
    /<mar-src(?: title="([^"]+)")?>\n?([\s\S]*?)<\/mar-src>/g,
    (_, title, body) => renderMarBlock(body, title ?? null),
  );
  return html;
}

function navFor(active) {
  return PAGES.filter((p) => p.nav)
    .map((p) => {
      const href = p.slug === 'index' ? '/' : `/${p.slug}`;
      const current = p.slug === active ? ' aria-current="page"' : '';
      return `    <li><a href="${href}"${current}>${p.nav}</a></li>`;
    })
    .join('\n');
}

export function build() {
  const layout = readFileSync(join(src, 'layout.html'), 'utf8');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  for (const page of PAGES) {
    const fragment = readFileSync(join(src, 'pages', `${page.slug}.html`), 'utf8');
    const html = layout
      .replaceAll('{{title}}', escapeHtml(page.title))
      .replaceAll('{{desc}}', escapeHtml(page.desc))
      .replaceAll('{{nav}}', navFor(page.slug))
      .replaceAll('{{content}}', expand(fragment));
    const out = page.slug === 'index' ? 'index.html'
      : page.slug === '404' ? '404.html'
        : join(page.slug, 'index.html');
    mkdirSync(dirname(join(dist, out)), { recursive: true });
    writeFileSync(join(dist, out), html);
  }

  for (const f of readdirSync(join(root, 'public'))) {
    cpSync(join(root, 'public', f), join(dist, f), { recursive: true });
  }

  // Stage the real compiler/walker (tsc output) for in-browser use on the
  // playground. Hashing is WebCrypto (globalThis.crypto), so the same
  // modules run on Node and in the browser with no shims.
  const repoDist = join(root, '..', 'dist');
  const LIB = ['types.js', 'hash.js', 'expr.js', 'gates.js', 'refs.js', 'suggest.js', 'parser.js', 'validate.js', 'compile.js', 'state.js', 'term.js'];
  mkdirSync(join(dist, 'lib'), { recursive: true });
  for (const f of LIB) {
    const src = join(repoDist, f);
    if (!existsSync(src)) throw new Error(`missing ${src} — run \`npm run build\` at the repo root first`);
    cpSync(src, join(dist, 'lib', f));
  }
  console.log(`built ${PAGES.length} pages → dist/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
