// Transcript fidelity gate: every rendered demo frame in dist/ must be a
// byte-exact match for its captured transcript (ANSI stripped), and the
// prompt line must be exactly the command from the manifest. If the CLI
// didn't print it, the site doesn't show it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAnsi } from './ansi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const transcripts = join(root, 'transcripts');
const manifest = Object.fromEntries(
  JSON.parse(readFileSync(join(transcripts, 'manifest.json'), 'utf8')).map((m) => [m.id, m]),
);

function* htmlFiles(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (f.endsWith('.html')) yield p;
  }
}

const unescape = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

let demos = 0;
let failures = 0;
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<section class="term" data-demo="([^"]+)"[\s\S]*?<pre class="term-screen"[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)) {
    demos++;
    const [, id, body] = m;
    const meta = manifest[id];
    const lines = [...body.matchAll(/<span class="t-line[^"]*">([\s\S]*?)<\/span>(?=<span class="t-line|$)/g)]
      .map((x) => unescape(x[1]));
    const cmdLine = lines.shift();
    const expectCmd = `$ ${meta.cmd}`;
    if (cmdLine !== expectCmd) {
      console.error(`FAIL ${id}: prompt line drifted\n  shown:    ${JSON.stringify(cmdLine)}\n  expected: ${JSON.stringify(expectCmd)}`);
      failures++;
    }
    const expected = stripAnsi(readFileSync(join(transcripts, `${id}.txt`), 'utf8')).replace(/\n$/, '');
    const shown = lines.join('\n');
    if (shown !== expected) {
      console.error(`FAIL ${id} in ${file}: rendered output is not the captured transcript`);
      const a = shown.split('\n');
      const b = expected.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.error(`  first divergence at line ${i + 1}:\n    shown:    ${JSON.stringify(a[i])}\n    captured: ${JSON.stringify(b[i])}`);
          break;
        }
      }
      failures++;
    }
  }
}

if (demos === 0) { console.error('FAIL: no demo casts found in dist/ — extraction regex drifted from build output'); failures++; }
if (failures) process.exit(1);
console.log(`fidelity: ${demos} demo casts match their captured transcripts byte-for-byte`);
