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
  { slug: 'index', nav: 'home', wide: true, title: 'Marionette — clear project plans for AI agents', desc: 'Write a plain-text project plan, try it in the browser playground, let an AI agent follow it, and keep important decisions with people.' },
  { slug: 'getting-started', nav: 'getting-started', title: 'Getting started — Marionette', desc: 'Install the marionette CLI, write and validate your first plan, and set it up with Claude Code, Codex, or OpenCode.',
    sections: [
      { id: 'cli', label: 'install the cli' },
      { id: 'first-plan', label: 'first plan' },
      { id: 'agents', label: 'your coding agent' },
      { id: 'traverse', label: 'run the plan' },
      { id: 'ci', label: 'ci' },
    ] },
  { slug: 'docs', nav: 'docs', title: 'Docs — Marionette', desc: 'One page for the whole tool: write a .mar plan, check it with the compiler, run it with an agent, change it safely, and look anything up.',
    sections: [
      { id: 'write', label: 'write a plan' },
      { id: 'check', label: 'check it' },
      { id: 'run', label: 'run it' },
      { id: 'change', label: 'change it safely' },
      { id: 'reference', label: 'reference' },
    ] },
  { slug: 'examples', nav: 'examples', title: 'Examples — Marionette', desc: 'Complete project plans you can edit and run in the browser: retries, fallback options, human approval, and larger migrations.',
    sections: [
      { id: 'checkout', label: 'checkout revamp' },
      { id: 'build-mvp', label: 'the mvp loop' },
      { id: 'meta', label: 'built this site' },
      { id: 'paas', label: 'an 18-phase replatform' },
      { id: 'use-cases', label: 'use-cases' },
    ] },
  { slug: 'execution', nav: 'execution', title: 'Execution — Marionette', desc: 'Connect an AI agent or another program to Marionette, record results, pause for human decisions, and report completed work.',
    sections: [
      { id: 'loop', label: 'the loop' },
      { id: 'brief', label: 'the brief as json' },
      { id: 'escalation', label: 'escalation' },
      { id: 'runtime', label: 'the runtime' },
      { id: 'delivery', label: 'delivery config' },
      { id: 'refs', label: 'external refs' },
      { id: 'conformance', label: 'conformance' },
    ] },
  { slug: '404', nav: null, title: 'Not found — Marionette', desc: 'No such page.' },
];

const manifest = JSON.parse(readFileSync(join(transcripts, 'manifest.json'), 'utf8'));
const manifestById = Object.fromEntries(manifest.map((m) => [m.id, m]));

function transcript(id) {
  return readFileSync(join(transcripts, `${id}.txt`), 'utf8');
}

const DOTS = '<span class="term-dots" aria-hidden="true"><i></i><i></i><i></i></span>';

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
<div class="term-bar">${DOTS}<span class="term-title">${escapeHtml(title)}</span><span class="term-exit ${exitCls}">exit ${meta.exit}</span></div>
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
    ? `<div class="term-bar">${DOTS}<span class="term-title">${escapeHtml(title)}</span></div>`
    : '';
  return `<div class="term">${bar}<pre class="term-screen mar" tabindex="0" aria-label="plan source (scrollable)"><code>${highlightMar(source)}</code></pre></div>`;
}

// <mini-playground src="checkout.mar" title="…"></mini-playground>
// An editable plan on the left, live diagnostics + walk on the right;
// mini.js compiles and walks it with the real compiler under /lib.
let miniSeq = 0;
function renderMini(file, title) {
  const source = readFileSync(join(transcripts, file), 'utf8');
  const n = ++miniSeq;
  return `<section class="mini" data-mini aria-label="${escapeHtml(title)} (editable example)">
<div class="term-bar">${DOTS}<span class="term-title">${escapeHtml(title)}</span><span class="term-exit" data-mini-status></span></div>
<div class="mini-panes">
<div class="mini-plan">
<textarea spellcheck="false" autocomplete="off" wrap="soft" aria-label="${escapeHtml(title)} — plan source; edits compile as you type">${escapeHtml(source)}</textarea>
</div>
<div class="mini-run">
<div class="pg-diagnostics" data-diagnostics role="log" aria-label="compiler diagnostics"></div>
<div class="pg-walk-controls">
<fieldset class="pg-actor"><legend>acting as</legend>
<label><input type="radio" name="mini-actor-${n}" value="agent" checked> agent</label>
<label><input type="radio" name="mini-actor-${n}" value="human"> human</label>
</fieldset>
<label class="pg-rationale-row">rationale <input type="text" value="trying the example"></label>
<button type="button" class="pg-reset" data-reset>↺ reset</button>
</div>
<div class="pg-node" data-node role="status"></div>
<div class="pg-choices" data-choices></div>
<ol class="pg-log" data-log aria-label="decision log"></ol>
</div>
</div>
</section>`;
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
  html = html.replace(
    /<mini-playground src="([^"]+)" title="([^"]+)"><\/mini-playground>/g,
    (_, file, title) => renderMini(file, title),
  );
  return html;
}

function navFor(active) {
  return PAGES.filter((p) => p.nav)
    .map((p) => {
      const href = p.slug === 'index' ? '/' : `/${p.slug}`;
      const current = p.slug === active ? ' aria-current="page"' : '';
      const link = `<a href="${href}"${current}>${p.nav}</a>`;
      if (!p.sections?.length) return `    <li>${link}</li>`;
      // Collapsible group: the summary carries the page link; the section
      // list expands on the page you're on and collapses elsewhere.
      const open = p.slug === active ? ' open' : '';
      const subs = p.sections
        .map((s) => `      <li><a class="nav-sub" href="${href}#${s.id}">${s.label}</a></li>`)
        .join('\n');
      return `    <li><details class="nav-group"${open}><summary>${link}</summary><ul>\n${subs}\n    </ul></details></li>`;
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
      .replaceAll('<main id="main">', page.wide ? '<main id="main" class="wide">' : '<main id="main">')
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
  // Entry points the browser imports; their local-import closure is staged
  // so the list can't drift when the compiler grows a module.
  const LIB = ['compile.js', 'state.js'];
  const staged = new Set();
  const stage = (f) => {
    if (staged.has(f)) return;
    staged.add(f);
    const src = join(repoDist, f);
    if (!existsSync(src)) throw new Error(`missing ${src} — run \`npm run build\` at the repo root first`);
    for (const m of readFileSync(src, 'utf8').matchAll(/from '\.\/([\w-]+\.js)'/g)) stage(m[1]);
  };
  for (const f of LIB) stage(f);
  mkdirSync(join(dist, 'lib'), { recursive: true });
  for (const f of staged) cpSync(join(repoDist, f), join(dist, 'lib', f));
  // Example plans for the playground dropdown, sourced from transcripts/.
  const EXAMPLES = [
    { file: 'checkout.mar', label: 'checkout-revamp — the plan the docs follow' },
    { file: 'checkout-broken.mar', label: 'checkout-revamp — first draft (2 errors to fix)' },
    { file: 'build_mvp.mar', label: 'build-mvp — the MVP loop' },
    { file: 'paas_replatform.mar', label: 'paas-replatform — an 18-phase programme' },
    { file: 'docs-site.mar', label: 'marionette-docs-site — the plan that built this site' },
  ].map((e) => ({ ...e, source: readFileSync(join(transcripts, e.file), 'utf8') }));
  writeFileSync(join(dist, 'examples-data.js'),
    'export const EXAMPLES = ' + JSON.stringify(EXAMPLES, null, 1) + ';\n');

  console.log(`built ${PAGES.length} pages → dist/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
