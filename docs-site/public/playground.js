// The playground: the real compiler + walker (tsc output under /lib,
// hashing via WebCrypto so the modules run unmodified) with a pannable SVG
// view of the graph. Diagnostics render in the same stage as the graph.
import { compile } from '/lib/compile.js';
import { initState, frontier, takeChoice, advance, observe, WalkError } from '/lib/state.js';
import { EXAMPLES } from '/examples-data.js';
import { enhanceMarEditor } from '/highlight.js';


function boot(el) {
  const srcEl = el.querySelector('#pg-src');
  const diagEl = el.querySelector('[data-diagnostics]');
  const nodeEl = el.querySelector('[data-node]');
  const choicesEl = el.querySelector('[data-choices]');
  const logEl = el.querySelector('[data-log]');
  const resetEl = el.querySelector('[data-reset]');
  const rationaleEl = el.querySelector('#pg-rationale');
  const canvasHost = el.querySelector('[data-canvas]');
  const paintEditor = enhanceMarEditor(el.querySelector('[data-code-editor]'), srcEl);

  let trajectory = null;
  let state = null;
  let refusal = null;
  let compileSeq = 0;
  const viz = makeViz(canvasHost);

  const exampleSel = el.querySelector('[data-examples]');
  for (const [i, ex] of EXAMPLES.entries()) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ex.label;
    exampleSel.append(opt);
  }
  const requestedExample = new URLSearchParams(window.location.search).get('example');
  const initialExample = Math.max(0, EXAMPLES.findIndex((example) =>
    example.file === requestedExample || example.file.replace(/\.mar$/, '') === requestedExample));
  exampleSel.value = String(initialExample);
  exampleSel.addEventListener('change', () => {
    srcEl.value = EXAMPLES[Number(exampleSel.value)].source;
    paintEditor();
    recompile();
  });
  srcEl.value = EXAMPLES[initialExample].source;
  paintEditor();
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
    const result = await compile(srcEl.value, { file: 'playground.mar' });
    if (seq !== compileSeq) return; // a newer keystroke superseded this compile
    renderDiagnostics(result.diagnostics);
    if (!result.trajectory || !result.ok) {
      trajectory = null;
      state = null;
      viz.clear();
      nodeEl.innerHTML = '';
      choicesEl.innerHTML = '';
      logEl.innerHTML = '';
      return;
    }
    const changed = !trajectory || trajectory.hash !== result.trajectory.hash;
    trajectory = result.trajectory;
    if (changed) {
      state = initState(trajectory);
      refusal = null;
      viz.setGraph(trajectory);
    }
    renderWalk();
  }

  function renderDiagnostics(diagnostics) {
    // The panel shares the stage with the graph: hidden while the plan is
    // clean (the rendered graph is the confirmation), a bottom strip for
    // warnings, the whole stage when compilation fails.
    if (diagnostics.length === 0) {
      diagEl.hidden = true;
      diagEl.innerHTML = '';
      return;
    }
    const items = diagnostics.map((d) => {
      const cls = d.severity === 'error' ? 'pg-err' : 'pg-warn';
      const where = d.line != null ? `playground.mar:${d.line}: ` : '';
      const help = d.suggestion ? `<span class="pg-help">help: ${esc(d.suggestion)}</span>` : '';
      return `<li class="${cls}"><strong>${where}${d.severity}[${esc(d.code)}]</strong>: ${esc(d.message)} ${help}</li>`;
    });
    diagEl.innerHTML = `<ul>${items.join('')}</ul>`;
    diagEl.hidden = false;
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
      for (const name of state.pendingObservations ?? []) {
        const decl = trajectory.variables[name];
        const row = document.createElement('div');
        row.className = 'pg-rationale-row';
        const field = document.createElement('label');
        field.textContent = `${name}:${decl?.type ?? 'unknown'} `;
        const input = decl?.type === 'boolean'
          ? document.createElement('select')
          : document.createElement('input');
        if (input instanceof HTMLSelectElement) {
          for (const value of ['true', 'false']) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            input.append(option);
          }
        } else {
          input.type = decl?.type === 'number' ? 'number' : 'text';
          input.step = 'any';
        }
        const submit = document.createElement('button');
        submit.type = 'button';
        submit.textContent = 'record observation';
        submit.addEventListener('click', () => {
          const raw = input.value;
          const value = decl?.type === 'number' ? (raw.trim() === '' ? Number.NaN : Number(raw))
            : decl?.type === 'boolean' ? raw === 'true'
            : raw;
          step(() => observe(trajectory, state, name, value, {
            actor: 'agent',
            rationale: rationaleEl.value || 'observed in the playground',
          }));
        });
        field.append(input);
        row.append(field, submit);
        choicesEl.append(row);
      }
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
            takeChoice(trajectory, state, String(i), { actor: 'agent', rationale: rationaleEl.value || undefined })));
        }
        choicesEl.append(btn);
      }
      if (node?.next) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `Continue automatically → ${node.next.target}`;
        btn.addEventListener('click', () => step(() =>
          advance(trajectory, state, { actor: 'agent', rationale: rationaleEl.value || undefined })));
        choicesEl.append(btn);
      }
    }

    logEl.innerHTML = state.log.map((e) => {
      const move = e.choice ? `chose “${esc(e.label ?? e.choice)}”` : 'advanced';
      return `<li><strong>${esc(e.actor)}</strong> ${move} → ${esc(e.to)}` +
        (e.rationale ? ` <span class="pg-why">— ${esc(e.rationale)}</span>` : '') + '</li>';
    }).join('');

    viz.setWalk(state);
  }
}


/* ---------- SVG graph view ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function makeViz(host) {
  let graph = null;
  let view = null;
  let homeView = null;
  let naturalView = null;
  let drag = null;

  const toolbar = document.createElement('div');
  toolbar.className = 'graph-toolbar';
  const hint = document.createElement('span');
  hint.className = 'graph-hint';
  hint.textContent = 'drag to pan · scroll to zoom';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'graph-zoom-label';
  const controls = [
    ['−', 'Zoom out', () => zoom(1.25)],
    ['+', 'Zoom in', () => zoom(0.8)],
    ['fit', 'Fit graph to view', fit],
  ];
  toolbar.append(hint, zoomLabel);
  for (const [text, label, action] of controls) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    toolbar.append(button);
  }

  const svg = svgEl('svg', {
    class: 'graph-svg',
    'aria-hidden': 'true',
    preserveAspectRatio: 'xMidYMid meet',
  });
  host.append(toolbar, svg);

  function setControls(enabled) {
    toolbar.querySelectorAll('button').forEach((button) => { button.disabled = !enabled; });
    zoomLabel.textContent = enabled && naturalView && view
      ? `${Math.round((naturalView.w / view.w) * 100)}%`
      : '';
  }

  function updateView() {
    if (!view) return;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    setControls(true);
  }

  function fit() {
    if (!homeView) return;
    view = { ...homeView };
    updateView();
  }

  function zoom(factor, anchorX = 0.5, anchorY = 0.5) {
    if (!homeView || !naturalView || !view) return;
    const nextW = Math.min(homeView.w * 2, Math.max(naturalView.w * 0.3, view.w * factor));
    const nextH = Math.min(homeView.h * 2, Math.max(naturalView.h * 0.3, view.h * factor));
    const pointX = view.x + view.w * anchorX;
    const pointY = view.y + view.h * anchorY;
    view = {
      x: pointX - nextW * anchorX,
      y: pointY - nextH * anchorY,
      w: nextW,
      h: nextH,
    };
    updateView();
  }

  svg.addEventListener('wheel', (event) => {
    if (!view) return;
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoom(event.deltaY < 0 ? 0.84 : 1.19,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height);
  }, { passive: false });

  svg.addEventListener('pointerdown', (event) => {
    if (!view || event.button !== 0) return;
    svg.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, view: { ...view } };
    svg.classList.add('is-panning');
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag || !view) return;
    const rect = svg.getBoundingClientRect();
    view = {
      ...drag.view,
      x: drag.view.x - (event.clientX - drag.x) * drag.view.w / rect.width,
      y: drag.view.y - (event.clientY - drag.y) * drag.view.h / rect.height,
    };
    updateView();
  });
  const stopPan = () => {
    drag = null;
    svg.classList.remove('is-panning');
  };
  svg.addEventListener('pointerup', stopPan);
  svg.addEventListener('pointercancel', stopPan);
  svg.addEventListener('dblclick', fit);

  function layout(trajectory) {
    const byId = new Map(trajectory.nodes.map((node) => [node.id, node]));
    const targets = (id) => {
      const node = byId.get(id);
      return [...(node?.choices.map((choice) => choice.target) ?? []),
        ...(node?.next ? [node.next.target] : [])];
    };
    const depth = new Map([[trajectory.start, 0]]);
    const queue = [trajectory.start];
    while (queue.length > 0) {
      const id = queue.shift();
      for (const target of targets(id)) {
        if (target === 'END' || depth.has(target)) continue;
        depth.set(target, depth.get(id) + 1);
        queue.push(target);
      }
    }

    let maxDepth = Math.max(0, ...depth.values());
    for (const node of trajectory.nodes) {
      if (!depth.has(node.id)) depth.set(node.id, ++maxDepth);
    }
    const usesEnd = trajectory.nodes.some((node) =>
      node.next?.target === 'END' || node.choices.some((choice) => choice.target === 'END'));
    const entries = trajectory.nodes.map((node) => ({
      id: node.id,
      node,
      depth: depth.get(node.id),
      title: node.body.split('\n')[0] ?? '',
    }));
    if (usesEnd) entries.push({ id: 'END', node: null, depth: maxDepth + 1, title: '' });

    const columns = new Map();
    for (const entry of entries) {
      const column = columns.get(entry.depth) ?? [];
      column.push(entry);
      columns.set(entry.depth, column);
    }

    const widthFor = (entry) => {
      if (entry.id === 'END') return 94;
      const title = entry.title.length > 38 ? entry.title.slice(0, 37) + '…' : entry.title;
      return Math.min(292, Math.max(170, Math.max(entry.id.length, title.length) * 7.2 + 40));
    };
    const rowGap = 116;
    const marginX = 86;
    const marginY = 86;
    const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
    const height = Math.max(330, maxRows * rowGap + marginY * 2);
    const boxes = new Map();
    let cursorX = marginX;

    for (const column of [...columns.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
      const columnWidth = Math.max(...column.map(widthFor));
      const columnHeight = (column.length - 1) * rowGap;
      for (const [rank, entry] of column.entries()) {
        const width = widthFor(entry);
        const y = height / 2 - columnHeight / 2 + rank * rowGap;
        boxes.set(entry.id, {
          ...entry,
          x: cursorX + (columnWidth - width) / 2,
          y: y - 32,
          w: width,
          h: 64,
        });
      }
      cursorX += columnWidth + 154;
    }
    const width = cursorX - 154 + marginX;

    const edges = [];
    for (const node of trajectory.nodes) {
      edges.push(...node.choices.map((choice) => ({
        id: choice.id,
        from: node.id,
        to: choice.target,
        human: choice.human,
        loop: choice.loop,
      })));
      if (node.next) {
        edges.push({
          id: `${node.id}=>next`,
          from: node.id,
          to: node.next.target,
          human: false,
          loop: false,
        });
      }
    }
    return { width, height, boxes, edges };
  }

  function edgePath(edge, boxes, backwardIndex) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) return '';
    if (edge.from === edge.to) {
      const x = from.x + from.w;
      const y = from.y + from.h / 2;
      return `M ${x} ${y} C ${x + 70} ${y - 76}, ${x + 70} ${y + 76}, ${x} ${y + 8}`;
    }
    if (to.x <= from.x) {
      const startX = from.x + from.w / 2;
      const endX = to.x + to.w / 2;
      const routeY = Math.max(22, Math.min(from.y, to.y) - 48 - (backwardIndex % 4) * 16);
      return `M ${startX} ${from.y} C ${startX} ${routeY}, ${endX} ${routeY}, ${endX} ${to.y}`;
    }
    const startX = from.x + from.w;
    const startY = from.y + from.h / 2;
    const endX = to.x;
    const endY = to.y + to.h / 2;
    const bend = Math.max(64, (endX - startX) * 0.42);
    return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
  }

  function setGraph(trajectory) {
    const drawing = layout(trajectory);
    const defs = svgEl('defs');
    const marker = svgEl('marker', {
      id: 'graph-arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'graph-arrow' }));
    defs.append(marker);

    const root = svgEl('g', { class: 'graph-root' });
    const edgeLayer = svgEl('g', { class: 'graph-edges' });
    const nodeLayer = svgEl('g', { class: 'graph-nodes' });
    const edgeEls = [];
    let backwardIndex = 0;

    for (const edge of drawing.edges) {
      const backward = drawing.boxes.get(edge.to)?.x <= drawing.boxes.get(edge.from)?.x;
      const path = svgEl('path', {
        d: edgePath(edge, drawing.boxes, backward ? backwardIndex++ : 0),
        class: [
          'graph-edge',
          edge.human ? 'is-human' : '',
          edge.loop ? 'is-loop' : '',
        ].filter(Boolean).join(' '),
        'marker-end': 'url(#graph-arrow)',
      });
      edgeLayer.append(path);
      edgeEls.push({ ...edge, el: path });
    }

    const nodeEls = new Map();
    for (const [id, box] of drawing.boxes) {
      const group = svgEl('g', {
        class: `graph-node${id === 'END' ? ' is-end' : ''}${id === trajectory.start ? ' is-start' : ''}`,
        transform: `translate(${box.x} ${box.y})`,
      });
      group.append(svgEl('rect', {
        class: 'graph-node-box',
        width: box.w,
        height: box.h,
        rx: id === 'END' ? 32 : 5,
      }));
      const label = svgEl('text', { class: 'graph-node-label', x: box.w / 2, y: id === 'END' ? 38 : 26 });
      const idLine = svgEl('tspan', { class: 'graph-node-id', x: box.w / 2 });
      idLine.textContent = id;
      label.append(idLine);
      if (id !== 'END' && box.title) {
        const title = box.title.length > 38 ? box.title.slice(0, 37) + '…' : box.title;
        const titleLine = svgEl('tspan', {
          class: 'graph-node-title',
          x: box.w / 2,
          dy: 20,
        });
        titleLine.textContent = title;
        label.append(titleLine);
      }
      group.append(label);
      if (id === trajectory.start) {
        const start = svgEl('text', { class: 'graph-start-label', x: 0, y: -12 });
        start.textContent = 'start';
        group.append(start);
      }
      nodeLayer.append(group);
      nodeEls.set(id, group);
    }

    root.append(edgeLayer, nodeLayer);
    svg.replaceChildren(defs, root);
    graph = { trajectory, nodeEls, edgeEls };
    homeView = { x: 0, y: 0, w: drawing.width, h: drawing.height };
    naturalView = { x: 0, y: 0, w: Math.min(1150, drawing.width), h: drawing.height };
    delete host.dataset.empty;
    view = { ...naturalView };
    updateView();
  }

  function setWalk(state) {
    if (!graph) return;
    const current = state.status === 'completed' ? 'END' : state.current;
    const visited = new Set([graph.trajectory.start, ...state.log.map((entry) => entry.to)]);
    const taken = new Set(state.log.filter((entry) => entry.choice).map((entry) => entry.choice));
    for (const entry of state.log) {
      if (!entry.choice && entry.from) taken.add(`${entry.from}=>next`);
    }
    for (const [id, node] of graph.nodeEls) {
      node.classList.toggle('is-current', id === current);
      node.classList.toggle('is-visited', visited.has(id));
    }
    for (const edge of graph.edgeEls) edge.el.classList.toggle('is-taken', taken.has(edge.id));
  }

  function clear() {
    host.dataset.empty = '';
    svg.replaceChildren();
    graph = null;
    view = null;
    homeView = null;
    naturalView = null;
    setControls(false);
  }

  clear();
  return { setGraph, setWalk, clear };
}

/* ---------- utils ---------- */

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

const rootEl = document.querySelector('[data-playground]');
if (rootEl) boot(rootEl);
