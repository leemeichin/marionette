// Example mini-playgrounds: each .mini[data-mini] is an editable plan
// (left pane) compiled and walked live by the real compiler + walker
// (tsc output under /lib) — same engine as the home-page playground,
// minus the 3D canvas. Without JS the plan source is still fully visible.
import { compile } from '/lib/compile.js';
import { initState, frontier, takeChoice, advance, WalkError } from '/lib/state.js';

function boot(el) {
  const srcEl = el.querySelector('textarea');
  const diagEl = el.querySelector('[data-diagnostics]');
  const nodeEl = el.querySelector('[data-node]');
  const choicesEl = el.querySelector('[data-choices]');
  const logEl = el.querySelector('[data-log]');
  const resetEl = el.querySelector('[data-reset]');
  const rationaleEl = el.querySelector('.pg-rationale-row input');
  const statusEl = el.querySelector('[data-mini-status]');

  let trajectory = null;
  let state = null;
  let refusal = null;
  let compileSeq = 0;

  srcEl.addEventListener('input', debounce(recompile, 250));
  resetEl.addEventListener('click', () => {
    if (!trajectory) return;
    state = initState(trajectory);
    refusal = null;
    renderWalk();
  });
  recompile();

  async function recompile() {
    const seq = ++compileSeq;
    const result = await compile(srcEl.value, { file: 'example.mar' });
    if (seq !== compileSeq) return; // a newer keystroke superseded this compile
    renderDiagnostics(result.diagnostics);
    if (!result.trajectory || !result.ok) {
      trajectory = null;
      state = null;
      nodeEl.innerHTML = '';
      choicesEl.innerHTML = '';
      logEl.innerHTML = '';
      setStatus('err', '✗ does not compile');
      return;
    }
    const changed = !trajectory || trajectory.hash !== result.trajectory.hash;
    trajectory = result.trajectory;
    if (changed) {
      state = initState(trajectory);
      refusal = null;
    }
    renderWalk();
  }

  function setStatus(cls, text) {
    if (!statusEl) return;
    statusEl.className = `term-exit ${cls}`;
    statusEl.textContent = text;
  }

  function renderDiagnostics(diagnostics) {
    if (diagnostics.length === 0) {
      diagEl.innerHTML = '<p class="pg-ok">✓ 0 errors, 0 warnings</p>';
      return;
    }
    const items = diagnostics.map((d) => {
      const cls = d.severity === 'error' ? 'pg-err' : 'pg-warn';
      const where = d.line != null ? `example.mar:${d.line}: ` : '';
      const help = d.suggestion ? `<span class="pg-help">help: ${esc(d.suggestion)}</span>` : '';
      return `<li class="${cls}"><strong>${where}${d.severity}[${esc(d.code)}]</strong>: ${esc(d.message)}${help}</li>`;
    });
    diagEl.innerHTML = `<ul>${items.join('')}</ul>`;
  }

  function actor() {
    return el.querySelector('.pg-actor input:checked').value;
  }

  function step(fn) {
    refusal = null;
    try {
      fn();
    } catch (e) {
      if (e instanceof WalkError) refusal = e;
      else throw e;
    }
    renderWalk();
  }

  function renderWalk() {
    if (!trajectory || !state) return;
    const node = trajectory.nodes.find((n) => n.id === state.current);
    const done = state.status === 'completed';
    setStatus(done ? 'ok' : '', done ? '✓ completed' : `at ${state.current}`);

    nodeEl.innerHTML = done
      ? `<strong>END</strong> — the plan is complete after ${state.log.length} step${state.log.length === 1 ? '' : 's'}.`
      : `<strong>${esc(state.current)}</strong>${node?.body ? ` — ${esc(node.body)}` : ''}` +
        `<span class="pg-vars">${esc(Object.entries(state.variables).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', '))}</span>`;

    choicesEl.innerHTML = '';
    if (refusal) {
      const p = document.createElement('p');
      p.className = 'pg-refusal';
      p.textContent = `refused (${refusal.code}): ${refusal.message}`;
      choicesEl.append(p);
    }
    if (!done) {
      for (const [i, { choice, blocked }] of frontier(trajectory, state).entries()) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const marks = [choice.human ? '✋ @human' : '', choice.loop ? '↻' : '', choice.gate ? `{${choice.gate.source}}` : ''].filter(Boolean).join(' ');
        btn.textContent = `[${i}] ${choice.label}${marks ? '  ' + marks : ''} -> ${choice.target}`;
        if (blocked) {
          btn.disabled = true;
          btn.title = `unavailable: ${blocked}`;
          btn.textContent += `  (unavailable: ${blocked})`;
        } else {
          btn.addEventListener('click', () => step(() =>
            takeChoice(trajectory, state, String(i), { actor: actor(), rationale: rationaleEl.value || undefined })));
        }
        choicesEl.append(btn);
      }
      if (node?.divert) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `(fallthrough) advance -> ${node.divert.target}`;
        btn.addEventListener('click', () => step(() =>
          advance(trajectory, state, { actor: actor(), rationale: rationaleEl.value || undefined })));
        choicesEl.append(btn);
      }
    }

    logEl.innerHTML = state.log.map((e) => {
      const move = e.choice ? `chose “${esc(e.label ?? e.choice)}”` : 'advanced';
      return `<li><strong>${esc(e.actor)}</strong> ${move} → ${esc(e.to)}` +
        (e.rationale ? ` <span class="pg-why">— ${esc(e.rationale)}</span>` : '') + '</li>';
    }).join('');
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

document.querySelectorAll('[data-mini]').forEach(boot);
