// ANSI SGR → HTML spans, covering exactly the codes the marionette CLI
// emits (src/term.ts): 31 red, 32 green, 33 yellow, 35 magenta, 36 cyan,
// 39 default fg, 1 bold, 2 dim, 22 normal intensity, 0 reset.

const COLOR = { 31: 'a-red', 32: 'a-green', 33: 'a-yellow', 35: 'a-magenta', 36: 'a-cyan' };

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert one line of ANSI text to HTML. State does not carry across lines
// in the CLI's output (styles open and close within a line).
export function ansiLineToHtml(line) {
  let out = '';
  let color = null;
  let bold = false;
  let dim = false;
  let buf = '';

  const flush = () => {
    if (!buf) return;
    const classes = [color, bold ? 'a-bold' : null, dim ? 'a-dim' : null].filter(Boolean);
    out += classes.length
      ? `<span class="${classes.join(' ')}">${escapeHtml(buf)}</span>`
      : escapeHtml(buf);
    buf = '';
  };

  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    buf += line.slice(last, m.index);
    last = re.lastIndex;
    flush();
    for (const part of (m[1] || '0').split(';')) {
      const code = Number(part || '0');
      if (code === 0) { color = null; bold = false; dim = false; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 39) color = null;
      else if (COLOR[code]) color = COLOR[code];
    }
  }
  buf += line.slice(last);
  flush();
  return out;
}

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
