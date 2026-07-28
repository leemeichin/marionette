// Build-time syntax tint for .mar source blocks. Line-oriented, like the
// language itself; unknown lines fall through as prose.

import { escapeHtml } from './ansi.mjs';

function highlightChoiceTail(s) {
  // s: the part after the * / + marker, already trimmed on the left.
  let html = '';
  let rest = s;
  const eat = (re, cls) => {
    const m = rest.match(re);
    if (!m) return false;
    html += cls ? `<span class="${cls}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
    rest = rest.slice(m[0].length);
    return true;
  };
  // any order: gates, labels, @human, ~loop~, then the destination arrow
  for (let guard = 0; guard < 20 && rest.length > 0; guard++) {
    if (eat(/^\s+/, null)) continue;
    if (eat(/^\{[^}]*\}/, 'mar-gate')) continue;
    if (eat(/^\[[^\]]*\]/, 'mar-label')) continue;
    if (eat(/^@human\b/, 'mar-human')) continue;
    if (eat(/^~loop~/, 'mar-loop')) continue;
    if (eat(/^->\s*\w+/, 'mar-target')) continue;
    if (eat(/^\S+/, null)) continue;
  }
  return html;
}

export function highlightMarLine(line) {
  const esc = () => escapeHtml(line);
  let m;
  if ((m = line.match(/^(\s*)(\/\/.*)$/))) {
    return escapeHtml(m[1]) + `<span class="mar-comment">${escapeHtml(m[2])}</span>`;
  }
  if (/^\s*#/.test(line)) return `<span class="mar-meta">${esc()}</span>`;
  if ((m = line.match(/^(\s*)(VAR)(\s+\w+\s*=\s*.*)$/))) {
    return escapeHtml(m[1]) + `<span class="mar-kw">${escapeHtml(m[2])}</span>` + escapeHtml(m[3]);
  }
  if (/^\s*===/.test(line)) return `<span class="mar-phase">${esc()}</span>`;
  if ((m = line.match(/^(\s*)([*+])(\s*)(.*)$/))) {
    return escapeHtml(m[1]) + `<span class="mar-kw">${escapeHtml(m[2])}</span>` +
      escapeHtml(m[3]) + highlightChoiceTail(m[4]);
  }
  if ((m = line.match(/^(\s*)(->\s*\w+)\s*$/))) {
    return escapeHtml(m[1]) + `<span class="mar-target">${escapeHtml(m[2])}</span>`;
  }
  if ((m = line.match(/^(\s*)(~)(\s*)(.*)$/))) {
    return escapeHtml(m[1]) + `<span class="mar-kw">~</span>` + escapeHtml(m[3]) + escapeHtml(m[4]);
  }
  if (line.trim() === '') return '';
  return `<span class="mar-prose">${esc()}</span>`;
}

export function highlightMar(source) {
  let inFence = false;
  return source.replace(/\n$/, '').split('\n').map((line) => {
    if (inFence) {
      if (line.trim() === '"""') { inFence = false; return `<span class="mar-meta">${escapeHtml(line)}</span>`; }
      return `<span class="mar-meta">${escapeHtml(line)}</span>`;
    }
    if (/^\s*#\s*.+?:\s+"""\s*$/.test(line)) { inFence = true; return `<span class="mar-meta">${escapeHtml(line)}</span>`; }
    return highlightMarLine(line);
  }).join('\n');
}
