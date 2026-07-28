// Tiny build-time highlighter for the handful of languages used in the
// docs. It keeps the site dependency-free and makes highlighting deliberate:
// shell examples, JSON payloads and Marionette source all share one palette.

import { escapeHtml } from './ansi.mjs';

function decodeHtml(source) {
  return source
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function tokenise(source, re, classify) {
  let out = '';
  let cursor = 0;
  for (const match of source.matchAll(re)) {
    out += escapeHtml(source.slice(cursor, match.index));
    const cls = classify(match[0], match);
    out += cls
      ? `<span class="${cls}">${escapeHtml(match[0])}</span>`
      : escapeHtml(match[0]);
    cursor = match.index + match[0].length;
  }
  return out + escapeHtml(source.slice(cursor));
}

function commentAt(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') { i++; continue; }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

function shell(source) {
  const commands = /^(?:marionette|npm|npx|git|curl|mkdir|cat|cd)$/;
  return source.split('\n').map((line) => {
    let prompt = '';
    let body = line;
    if (body.startsWith('$ ')) {
      prompt = '<span class="tok-prompt">$ </span>';
      body = body.slice(2);
    }
    const at = commentAt(body);
    const command = at === -1 ? body : body.slice(0, at);
    const comment = at === -1 ? '' : body.slice(at);
    const highlighted = tokenise(
      command,
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:^|\s)--?[\w-]+|&&|\|\||[|>]|(?:^|\s)(?:marionette|npm|npx|git|curl|mkdir|cat|cd)(?=\s|$)/g,
      (value) => {
        const word = value.trim();
        if (/^["']/.test(word)) return 'tok-string';
        if (/^--?/.test(word)) return 'tok-flag';
        if (/^(?:&&|\|\||\||>)$/.test(word)) return 'tok-operator';
        if (commands.test(word)) return 'tok-command';
        return null;
      },
    );
    return prompt + highlighted +
      (comment ? `<span class="tok-comment">${escapeHtml(comment)}</span>` : '');
  }).join('\n');
}

function json(source) {
  return tokenise(
    source,
    /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b/g,
    (value, match) => {
      if (value.startsWith('"')) return /^\s*:/.test(source.slice((match.index ?? 0) + value.length))
        ? 'tok-key' : 'tok-string';
      if (/^-?\d/.test(value)) return 'tok-number';
      return 'tok-literal';
    },
  );
}

export function highlightCode(source, language) {
  const decoded = decodeHtml(source).replace(/^\n|\n$/g, '');
  if (language === 'shell' || language === 'console') return shell(decoded);
  if (language === 'json' || language === 'ndjson') return json(decoded);
  return escapeHtml(decoded);
}
