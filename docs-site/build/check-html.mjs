// Structural accessibility gate for every built page: landmarks, skip
// link, heading sanity, labelled controls, language. Cheap checks that
// catch real regressions — not a substitute for a manual audit.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function* htmlFiles(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (f.endsWith('.html')) yield p;
  }
}

let failures = 0;
const fail = (file, msg) => { console.error(`FAIL ${file.replace(dist + '/', '')}: ${msg}`); failures++; };

let pages = 0;
for (const file of htmlFiles(dist)) {
  pages++;
  const html = readFileSync(file, 'utf8');
  if (!/<html lang="en">/.test(html)) fail(file, 'missing <html lang>');
  if (!/class="skip-link" href="#main"/.test(html)) fail(file, 'missing skip link');
  for (const landmark of ['<header', '<nav', '<main id="main"', '<footer']) {
    if (!html.includes(landmark)) fail(file, `missing landmark ${landmark}`);
  }
  const h1s = html.match(/<h1[\s>]/g) || [];
  if (h1s.length !== 1) fail(file, `expected exactly one h1, found ${h1s.length}`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail(file, 'missing title');
  if (!/meta name="description" content="[^"]+"/.test(html)) fail(file, 'missing meta description');
  // every button carries text or an aria-label
  for (const m of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (!text && !/aria-label=/.test(m[0])) fail(file, `unlabelled button: ${m[0].slice(0, 60)}`);
  }
  // images need alt
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt=/.test(m[0])) fail(file, `img without alt: ${m[0].slice(0, 60)}`);
  }
  // demo terminals must be labelled regions
  for (const m of html.matchAll(/<section class="term"[^>]*>/g)) {
    if (!/aria-label=/.test(m[0])) fail(file, `demo terminal without aria-label: ${m[0].slice(0, 60)}`);
  }
  // nav marks the current page (404 excepted)
  if (!file.endsWith('404.html') && !html.includes('aria-current="page"')) {
    fail(file, 'nav has no aria-current="page"');
  }
}

if (failures) process.exit(1);
console.log(`html: ${pages} pages pass structural accessibility checks`);
