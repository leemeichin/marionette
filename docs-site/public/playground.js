// The playground: the real compiler + walker (tsc output under /lib,
// node:crypto shimmed via the page's import map) with a Three.js view of
// the graph. The DOM controls are the accessible interface; the canvas is
// aria-hidden garnish. No autoplay; reduced motion = no tweens.
import * as THREE from 'three';
import { compile } from '/lib/compile.js';
import { initState, frontier, takeChoice, advance, WalkError } from '/lib/state.js';

const rootEl = document.querySelector('[data-playground]');
if (rootEl) boot(rootEl);

function boot(el) {
  const srcEl = el.querySelector('#pg-src');
  const diagEl = el.querySelector('[data-diagnostics]');
  const nodeEl = el.querySelector('[data-node]');
  const choicesEl = el.querySelector('[data-choices]');
  const logEl = el.querySelector('[data-log]');
  const resetEl = el.querySelector('[data-reset]');
  const rationaleEl = el.querySelector('#pg-rationale');
  const canvasHost = el.querySelector('[data-canvas]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const STARTER = `# project: checkout-revamp
VAR attempts = 0

=== build_checkout ===
Rebuild the checkout flow behind a feature flag.
~ attempts += 1
* [Cohort converts] @human -> rollout
+ {attempts < 5} [Conversion flat — iterate] ~loop~ -> build_checkout
* {attempts >= 5} [Not converging — rethink] @human -> rethink

=== rethink ===
Five iterations without lift: take the flow back to research.
+ [New direction agreed] @human ~loop~ -> build_checkout
* [Park the revamp] @human -> END

=== rollout ===
Ramp the flag to 100% and retire the old flow.
-> END
`;

  let trajectory = null;
  let state = null;
  let refusal = null;
  const viz = makeViz(canvasHost, reduced);

  srcEl.value = STARTER;
  srcEl.addEventListener('input', debounce(recompile, 250));
  resetEl.addEventListener('click', () => {
    if (!trajectory) return;
    state = initState(trajectory);
    refusal = null;
    renderWalk();
  });

  // re-theme the scene when the palette changes
  document.querySelector('.theme-toggle')?.addEventListener('click', () => queueMicrotask(() => viz.retheme()));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => viz.retheme());

  recompile();

  function recompile() {
    const result = compile(srcEl.value, { file: 'playground.mar' });
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
    if (diagnostics.length === 0) {
      diagEl.innerHTML = '<p class="pg-ok">✓ 0 errors, 0 warnings — the plan compiles</p>';
      return;
    }
    const items = diagnostics.map((d) => {
      const cls = d.severity === 'error' ? 'pg-err' : 'pg-warn';
      const where = d.line != null ? `playground.mar:${d.line}: ` : '';
      const help = d.suggestion ? `<span class="pg-help">help: ${esc(d.suggestion)}</span>` : '';
      return `<li class="${cls}"><strong>${where}${d.severity}[${esc(d.code)}]</strong>: ${esc(d.message)}${help}</li>`;
    });
    diagEl.innerHTML = `<ul>${items.join('')}</ul>`;
  }

  function actor() {
    return el.querySelector('input[name="pg-actor"]:checked').value;
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

    viz.setWalk(state);
  }
}

/* ---------- three.js view ---------- */

function makeViz(host, reduced) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    host.innerHTML = '<p class="pg-hint">WebGL is unavailable in this browser — the walk controls below still work fully.</p>';
    return { setGraph() {}, setWalk() {}, retheme() {}, clear() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(4, 6, 8);
  scene.add(key);

  let graph = null;        // { nodesById: Map<id, {mesh, label, pos}>, edges: [{choiceId, from, to, line, cone, human}] }
  let current = null;
  let takenChoices = new Set();
  let visited = new Set();
  let pulse = 0;
  let raf = null;

  const css = () => getComputedStyle(document.documentElement);
  const col = (name) => new THREE.Color(css().getPropertyValue(name).trim());

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  new ResizeObserver(resize).observe(host);

  function layout(trajectory) {
    // BFS layering from the start node; END gets the last column.
    const depth = new Map([[trajectory.start, 0]]);
    const queue = [trajectory.start];
    const out = (id) => {
      const n = trajectory.nodes.find((x) => x.id === id);
      return [...(n?.choices.map((c) => c.target) ?? []), ...(n?.divert ? [n.divert.target] : [])];
    };
    while (queue.length) {
      const id = queue.shift();
      for (const t of out(id)) {
        if (t === 'END' || depth.has(t)) continue;
        depth.set(t, depth.get(id) + 1);
        queue.push(t);
      }
    }
    let maxDepth = Math.max(0, ...depth.values());
    for (const n of trajectory.nodes) if (!depth.has(n.id)) depth.set(n.id, ++maxDepth); // unreachable can't compile, but be safe
    const endDepth = Math.max(0, ...depth.values()) + 1;
    const columns = new Map();
    const place = (id, d) => {
      const rank = columns.get(d) ?? 0;
      columns.set(d, rank + 1);
      return { d, rank };
    };
    const slots = new Map();
    for (const n of trajectory.nodes) slots.set(n.id, place(n.id, depth.get(n.id)));
    slots.set('END', place('END', endDepth));
    const colCount = new Map();
    for (const { d } of slots.values()) colCount.set(d, (colCount.get(d) ?? 0) + 1);
    const pos = new Map();
    for (const [id, { d, rank }] of slots) {
      const n = colCount.get(d);
      pos.set(id, new THREE.Vector3(d * 3.4 - endDepth * 1.7, (rank - (n - 1) / 2) * -2.0, 0));
    }
    return pos;
  }

  function labelSprite(text, colorHex) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = '600 30px ui-monospace, Menlo, Consolas, monospace';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 24;
    c.width = w; c.height = 44;
    ctx.font = font;
    ctx.fillStyle = colorHex;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, 24);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(w / 46, 44 / 46, 1);
    return spr;
  }

  function setGraph(trajectory) {
    clear();
    const pos = layout(trajectory);
    graph = { trajectory, nodesById: new Map(), edges: [], pos };

    for (const [id, p] of pos) {
      const isEnd = id === 'END';
      const geo = isEnd ? new THREE.SphereGeometry(0.34, 24, 16) : new THREE.BoxGeometry(2.4, 0.9, 0.5);
      const mat = new THREE.MeshLambertMaterial();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(p);
      scene.add(mesh);
      const label = labelSprite(id, '#ffffff');
      label.position.set(p.x, p.y + (isEnd ? 0.85 : 0.95), p.z + 0.3);
      scene.add(label);
      graph.nodesById.set(id, { mesh, label });
    }

    for (const n of trajectory.nodes) {
      const from = pos.get(n.id);
      const links = [
        ...n.choices.map((c) => ({ id: c.id, target: c.target, human: c.human, loop: c.loop })),
        ...(n.divert ? [{ id: `${n.id}=>divert`, target: n.divert.target, human: false, loop: false }] : []),
      ];
      for (const link of links) {
        const to = pos.get(link.target);
        const backward = to.x <= from.x && link.target !== n.id;
        const self = link.target === n.id;
        const mid = self
          ? new THREE.Vector3(from.x, from.y + 1.7, from.z + 1.2)
          : new THREE.Vector3((from.x + to.x) / 2, (from.y + to.y) / 2 + (backward ? 2.2 : 0), (backward ? 1.6 : 0.7));
        const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, self ? from.clone().add(new THREE.Vector3(0.01, 0, 0)) : to.clone());
        const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(32));
        const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial());
        scene.add(line);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 10), new THREE.MeshLambertMaterial());
        const tEnd = 0.92;
        cone.position.copy(curve.getPoint(tEnd));
        cone.lookAt(curve.getPoint(1));
        cone.rotateX(Math.PI / 2);
        scene.add(cone);
        graph.edges.push({ choiceId: link.id, human: link.human, line, cone });
      }
    }

    // frame the graph
    const box = new THREE.Box3();
    for (const { mesh } of graph.nodesById.values()) box.expandByObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    camera.position.set(center.x, center.y, center.z + Math.max(size.x, size.y * 1.6) * 1.15 + 4);
    camera.lookAt(center);
    retheme();
  }

  function setWalk(state) {
    if (!graph) return;
    current = state.status === 'completed' ? 'END' : state.current;
    visited = new Set(['END', ...state.log.map((e) => e.to), graph.trajectory.start]);
    if (state.status !== 'completed') visited.delete('END');
    takenChoices = new Set(state.log.filter((e) => e.choice).map((e) => e.choice));
    for (const e of state.log) if (!e.choice && e.from) takenChoices.add(`${e.from}=>divert`);
    retheme();
    if (!reduced.matches) startPulse();
  }

  function retheme() {
    if (!graph) { render(); return; }
    const cNode = col('--bg-elev');
    const cVisited = col('--accent');
    const cEdge = col('--fg-dim');
    const cTaken = col('--accent');
    const cHuman = col('--magenta');
    const labelCol = css().getPropertyValue('--fg').trim();
    for (const [id, { mesh, label }] of graph.nodesById) {
      const isCurrent = id === current;
      const wasVisited = visited.has(id);
      mesh.material.color.copy(isCurrent ? col('--green') : wasVisited ? cVisited : cNode);
      mesh.material.opacity = isCurrent || wasVisited ? 1 : 0.9;
      mesh.scale.setScalar(isCurrent ? 1.12 : 1);
      // refresh label color by redrawing (cheap, few nodes)
      const fresh = labelSprite(id, isCurrent ? css().getPropertyValue('--accent').trim() : labelCol);
      fresh.position.copy(label.position);
      scene.remove(label);
      scene.add(fresh);
      graph.nodesById.get(id).label = fresh;
    }
    for (const e of graph.edges) {
      const taken = takenChoices.has(e.choiceId);
      const c = taken ? cTaken : e.human ? cHuman : cEdge;
      e.line.material.color.copy(c);
      e.line.material.opacity = taken ? 1 : 0.9;
      e.line.material.transparent = true;
      e.cone.material.color.copy(c);
    }
    render();
  }

  function startPulse() {
    if (raf) return;
    const t0 = performance.now();
    const tick = (t) => {
      pulse = (t - t0) / 1000;
      const cur = current && graph?.nodesById.get(current);
      if (cur) cur.mesh.scale.setScalar(1.12 + Math.sin(pulse * 3) * 0.04);
      render();
      if (pulse < 2.5) raf = requestAnimationFrame(tick);
      else { raf = null; cur?.mesh.scale.setScalar(1.12); render(); }
    };
    raf = requestAnimationFrame(tick);
  }

  function clear() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    scene.clear();
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const k = new THREE.DirectionalLight(0xffffff, 1.2);
    k.position.set(4, 6, 8);
    scene.add(k);
    graph = null;
    current = null;
    takenChoices = new Set();
    visited = new Set();
    render();
  }

  function render() { renderer.render(scene, camera); }
  resize();
  return { setGraph, setWalk, retheme, clear };
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
