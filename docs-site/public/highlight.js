// Browser-side .mar highlighting for editable examples. The textarea is
// untouched and remains the only interactive/accessibility surface; this
// module paints an aria-hidden mirror beneath it.

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function choiceTail(source) {
  let html = '';
  let rest = source;
  const take = (re, cls) => {
    const match = rest.match(re);
    if (!match) return false;
    html += cls ? `<span class="${cls}">${esc(match[0])}</span>` : esc(match[0]);
    rest = rest.slice(match[0].length);
    return true;
  };
  for (let guard = 0; guard < 20 && rest; guard++) {
    if (take(/^\s+/, null)) continue;
    if (take(/^\{[^}]*\}/, 'mar-gate')) continue;
    if (take(/^\[[^\]]*\]/, 'mar-label')) continue;
    if (take(/^@human\b/, 'mar-human')) continue;
    if (take(/^~loop~/, 'mar-loop')) continue;
    if (take(/^->\s*\w+/, 'mar-target')) continue;
    if (take(/^\S+/, null)) continue;
  }
  return html;
}

function line(source) {
  let match;
  if ((match = source.match(/^(\s*)(\/\/.*)$/))) {
    return esc(match[1]) + `<span class="mar-comment">${esc(match[2])}</span>`;
  }
  if (/^\s*#/.test(source)) return `<span class="mar-meta">${esc(source)}</span>`;
  if ((match = source.match(/^(\s*)(VAR)(\s+\w+\s*=\s*.*)$/))) {
    return esc(match[1]) + `<span class="mar-kw">${esc(match[2])}</span>` + esc(match[3]);
  }
  if (/^\s*===/.test(source)) return `<span class="mar-phase">${esc(source)}</span>`;
  if ((match = source.match(/^(\s*)([*+])(\s*)(.*)$/))) {
    return esc(match[1]) + `<span class="mar-kw">${esc(match[2])}</span>` +
      esc(match[3]) + choiceTail(match[4]);
  }
  if ((match = source.match(/^(\s*)(->\s*\w+)\s*$/))) {
    return esc(match[1]) + `<span class="mar-target">${esc(match[2])}</span>`;
  }
  if ((match = source.match(/^(\s*)(~)(\s*)(.*)$/))) {
    return esc(match[1]) + '<span class="mar-kw">~</span>' + esc(match[3] + match[4]);
  }
  return source.trim() ? `<span class="mar-prose">${esc(source)}</span>` : '';
}

export function highlightMar(source) {
  let inFence = false;
  return source.split('\n').map((sourceLine) => {
    if (inFence) {
      if (sourceLine.trim() === '"""') inFence = false;
      return `<span class="mar-meta">${esc(sourceLine)}</span>`;
    }
    if (/^\s*#\s*.+?:\s+"""\s*$/.test(sourceLine)) {
      inFence = true;
      return `<span class="mar-meta">${esc(sourceLine)}</span>`;
    }
    return line(sourceLine);
  }).join('\n');
}

export function enhanceMarEditor(host, textarea) {
  const mirror = host?.querySelector('[data-highlight]');
  if (!host || !textarea || !mirror) return () => {};

  const paint = () => {
    mirror.innerHTML = `${highlightMar(textarea.value)}\n`;
  };
  const sync = () => {
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  };

  textarea.addEventListener('input', paint);
  textarea.addEventListener('scroll', sync, { passive: true });
  paint();
  sync();
  host.classList.add('is-highlighted');
  return paint;
}
