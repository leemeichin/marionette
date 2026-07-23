// WCAG AA gate: every foreground token must hit ≥ 4.5:1 on every
// background token, in both themes, parsed from public/tokens.css itself
// so the check can't drift from the shipped values.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tokens.css'),
  'utf8',
);

function tokensFrom(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

function blockFor(selector) {
  const i = css.indexOf(selector);
  if (i === -1) throw new Error(`selector not found: ${selector}`);
  return css.slice(i, css.indexOf('}', i));
}

const light = tokensFrom(blockFor(':root {'));
const dark = tokensFrom(blockFor(':root[data-theme="dark"]'));

const lum = (hex) => {
  const c = hex.slice(1);
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const BACKGROUNDS = ['bg', 'bg-elev', 'bg-code'];
const FOREGROUNDS = ['fg', 'fg-dim', 'fg-faint', 'green', 'red', 'yellow', 'cyan', 'magenta', 'accent', 'focus'];

let failures = 0;
let worst = { r: Infinity };
for (const [name, theme] of [['dark', dark], ['light', light]]) {
  for (const bg of BACKGROUNDS) {
    for (const fg of FOREGROUNDS) {
      if (!theme[fg] || !theme[bg]) { console.error(`missing token ${fg}/${bg} in ${name}`); failures++; continue; }
      const r = ratio(theme[fg], theme[bg]);
      if (r < worst.r) worst = { r, name, fg, bg };
      if (r < 4.5) {
        console.error(`FAIL ${name}: --${fg} on --${bg} = ${r.toFixed(2)} (< 4.5)`);
        failures++;
      }
    }
  }
}

if (failures) process.exit(1);
console.log(`contrast: ${2 * BACKGROUNDS.length * FOREGROUNDS.length} pairs AA — worst ${worst.name} --${worst.fg} on --${worst.bg} at ${worst.r.toFixed(2)}:1`);
