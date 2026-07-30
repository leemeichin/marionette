/**
 * Dependency-free SVG rendering for plan review outside a terminal.
 *
 * The layout intentionally favours a legible review artifact over a perfect
 * graph drawing: breadth-first ranks establish the main flow while loops and
 * back edges are routed around their nodes. The resulting file opens in any
 * browser and does not require Mermaid CLI or Chromium.
 */

import { frontier, visitedPath } from './state.ts';
import { END, type PlanState, type Trajectory } from './types.ts';

export interface SvgRenderOptions {
  state?: PlanState | null;
  direction?: 'TD' | 'LR';
}

interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  width: number;
  height: number;
}

const NODE_WIDTH = 260;
const NODE_HEIGHT = 84;
const RANK_GAP = 150;
const NODE_GAP = 70;
const MARGIN = 70;

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function titleOf(body: string): string {
  return body.split('\n')[0]?.trim() ?? '';
}

function wrap(text: string, width = 34, lines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      result.push(current);
      current = word;
      if (result.length === lines - 1) break;
    } else {
      current += `${current ? ' ' : ''}${word}`;
    }
  }
  if (current && result.length < lines) result.push(current);
  if (words.join(' ').length > result.join(' ').length && result.length > 0) {
    result[result.length - 1] = `${result[result.length - 1]!.replace(/[.…]+$/, '')}…`;
  }
  return result;
}

function ranksFor(trajectory: Trajectory): string[][] {
  const level = new Map<string, number>([[trajectory.start, 0]]);
  const queue = [trajectory.start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = trajectory.nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    const targets = [...node.choices.map((choice) => choice.target), node.next?.target]
      .filter((target): target is string => Boolean(target));
    for (const target of targets) {
      if (target === id || level.has(target)) continue;
      level.set(target, (level.get(id) ?? 0) + 1);
      if (target !== END) queue.push(target);
    }
  }
  for (const node of trajectory.nodes) {
    if (!level.has(node.id)) level.set(node.id, Math.max(0, ...level.values()) + 1);
  }
  const usesEnd = trajectory.nodes.some((node) =>
    node.next?.target === END || node.choices.some((choice) => choice.target === END));
  if (usesEnd && !level.has(END)) level.set(END, Math.max(0, ...level.values()) + 1);
  const ranks: string[][] = [];
  for (const [id, rank] of level) (ranks[rank] ??= []).push(id);
  return ranks.filter(Boolean);
}

function positionsFor(trajectory: Trajectory, direction: 'TD' | 'LR'): {
  boxes: Map<string, Box>;
  width: number;
  height: number;
} {
  const ranks = ranksFor(trajectory);
  const maxRankSize = Math.max(1, ...ranks.map((rank) => rank.length));
  const boxes = new Map<string, Box>();
  if (direction === 'TD') {
    const width = MARGIN * 2 + maxRankSize * NODE_WIDTH + (maxRankSize - 1) * NODE_GAP;
    for (let row = 0; row < ranks.length; row++) {
      const rank = ranks[row]!;
      const rankWidth = rank.length * NODE_WIDTH + (rank.length - 1) * NODE_GAP;
      const startX = (width - rankWidth) / 2;
      rank.forEach((id, column) => boxes.set(id, {
        x: startX + column * (NODE_WIDTH + NODE_GAP),
        y: MARGIN + row * (NODE_HEIGHT + RANK_GAP),
        width: id === END ? 100 : NODE_WIDTH,
        height: id === END ? 56 : NODE_HEIGHT,
      }));
    }
    return {
      boxes,
      width,
      height: MARGIN * 2 + ranks.length * NODE_HEIGHT + Math.max(0, ranks.length - 1) * RANK_GAP,
    };
  }
  const height = MARGIN * 2 + maxRankSize * NODE_HEIGHT + (maxRankSize - 1) * NODE_GAP;
  for (let column = 0; column < ranks.length; column++) {
    const rank = ranks[column]!;
    const rankHeight = rank.length * NODE_HEIGHT + (rank.length - 1) * NODE_GAP;
    const startY = (height - rankHeight) / 2;
    rank.forEach((id, row) => boxes.set(id, {
      x: MARGIN + column * (NODE_WIDTH + RANK_GAP),
      y: startY + row * (NODE_HEIGHT + NODE_GAP),
      width: id === END ? 100 : NODE_WIDTH,
      height: id === END ? 56 : NODE_HEIGHT,
    }));
  }
  return {
    boxes,
    width: MARGIN * 2 + ranks.length * NODE_WIDTH + Math.max(0, ranks.length - 1) * RANK_GAP,
    height,
  };
}

function anchor(box: Box, side: 'top' | 'right' | 'bottom' | 'left'): Point {
  switch (side) {
    case 'top': return { x: box.x + box.width / 2, y: box.y };
    case 'right': return { x: box.x + box.width, y: box.y + box.height / 2 };
    case 'bottom': return { x: box.x + box.width / 2, y: box.y + box.height };
    case 'left': return { x: box.x, y: box.y + box.height / 2 };
  }
}

function edgePath(from: Box, to: Box, direction: 'TD' | 'LR'): { path: string; label: Point } {
  if (from === to) {
    const start = anchor(from, 'right');
    return {
      path: `M ${start.x} ${start.y} C ${start.x + 90} ${start.y - 70}, ${start.x + 90} ${start.y + 70}, ${start.x} ${start.y + 10}`,
      label: { x: start.x + 88, y: start.y - 4 },
    };
  }
  if (direction === 'TD') {
    const start = anchor(from, 'bottom');
    const end = anchor(to, 'top');
    const middle = (start.y + end.y) / 2;
    return {
      path: `M ${start.x} ${start.y} C ${start.x} ${middle}, ${end.x} ${middle}, ${end.x} ${end.y}`,
      label: { x: (start.x + end.x) / 2, y: middle - 8 },
    };
  }
  const start = anchor(from, 'right');
  const end = anchor(to, 'left');
  const middle = (start.x + end.x) / 2;
  return {
    path: `M ${start.x} ${start.y} C ${middle} ${start.y}, ${middle} ${end.y}, ${end.x} ${end.y}`,
    label: { x: middle, y: (start.y + end.y) / 2 - 8 },
  };
}

export async function renderSvg(
  trajectory: Trajectory,
  options: SvgRenderOptions = {},
): Promise<string> {
  const direction = options.direction ?? 'TD';
  const { boxes, width, height } = positionsFor(trajectory, direction);
  const state = options.state ?? null;
  const taken = state ? new Set(visitedPath(state)) : new Set<string>();
  const available = state?.status === 'active'
    ? new Set((await frontier(trajectory, state)).filter((item) => !item.blocked).map((item) => item.choice.target))
    : new Set<string>();
  const edges: string[] = [];

  for (const node of trajectory.nodes) {
    const from = boxes.get(node.id);
    if (!from) continue;
    const routes = [
      ...node.choices.map((choice) => ({
        target: choice.target,
        label: `${choice.human ? '✋ ' : ''}${choice.ask ? '‽ ' : ''}${choice.loop ? '↻ ' : ''}${choice.label}`,
        kind: choice.human ? 'human' : choice.ask ? 'ask' : choice.loop ? 'loop' : 'normal',
      })),
      ...(node.next ? [{ target: node.next.target, label: '', kind: 'normal' }] : []),
    ];
    for (const route of routes) {
      const to = boxes.get(route.target);
      if (!to) continue;
      const geometry = edgePath(from, to, direction);
      edges.push(`<path class="edge ${route.kind}" d="${geometry.path}" marker-end="url(#arrow-${route.kind})"/>`);
      if (route.label) {
        edges.push(`<text class="edge-label ${route.kind}" x="${geometry.label.x}" y="${geometry.label.y}" text-anchor="middle">${xml(route.label)}</text>`);
      }
    }
  }

  const nodes: string[] = [];
  for (const [id, box] of boxes) {
    if (id === END) {
      nodes.push(`<g class="node end"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="28"/><text x="${box.x + box.width / 2}" y="${box.y + 35}" text-anchor="middle">END</text></g>`);
      continue;
    }
    const node = trajectory.nodes.find((candidate) => candidate.id === id)!;
    const classes = [
      'node',
      id === trajectory.start ? 'start' : '',
      taken.has(id) ? 'taken' : '',
      state?.status === 'active' && state.current === id ? 'current' : '',
      available.has(id) && state?.current !== id ? 'frontier' : '',
    ].filter(Boolean).join(' ');
    const lines = wrap(titleOf(node.body));
    nodes.push(`<g class="${classes}"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12"/><text class="node-id" x="${box.x + 18}" y="${box.y + 27}">${xml(id)}</text>${lines.map((line, index) => `<text class="node-title" x="${box.x + 18}" y="${box.y + 50 + index * 18}">${xml(line)}</text>`).join('')}</g>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Marionette plan graph</title>
  <desc id="desc">${xml(`${trajectory.nodes.length} phase workflow starting at ${trajectory.start}`)}</desc>
  <defs>
    <marker id="arrow-normal" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#52606d"/></marker>
    <marker id="arrow-loop" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#007c83"/></marker>
    <marker id="arrow-human" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#7d3e80"/></marker>
    <marker id="arrow-ask" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#9a6700"/></marker>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#172b4d" flood-opacity=".14"/></filter>
  </defs>
  <style>
    svg { background: #f7f8fa; }
    text { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #172b4d; }
    .node rect { fill: #ffffff; stroke: #52606d; stroke-width: 1.5; filter: url(#shadow); }
    .node.start rect { fill: #eef8f2; stroke: #2f7d4a; }
    .node.taken rect { fill: #dcebea; stroke: #176b63; stroke-width: 2; }
    .node.current rect { stroke: #3f6f00; stroke-width: 4; }
    .node.frontier rect { stroke: #007c83; stroke-width: 2.5; stroke-dasharray: 7 5; }
    .node.end rect { fill: #172b4d; stroke: #172b4d; filter: url(#shadow); }
    .node.end text { fill: #ffffff; font-weight: 700; }
    .node-id { font: 700 15px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .node-title { font-size: 13px; fill: #52606d; }
    .edge { fill: none; stroke: #52606d; stroke-width: 2; }
    .edge.loop { stroke: #007c83; stroke-dasharray: 7 5; }
    .edge.human { stroke: #7d3e80; stroke-width: 3; }
    .edge.ask { stroke: #9a6700; stroke-width: 3; }
    .edge-label { font-size: 12px; font-weight: 600; paint-order: stroke; stroke: #f7f8fa; stroke-width: 8; stroke-linejoin: round; }
    .edge-label.loop { fill: #006a72; }
    .edge-label.human { fill: #6f3272; }
    .edge-label.ask { fill: #815700; }
  </style>
  <g class="edges">${edges.join('')}</g>
  <g class="nodes">${nodes.join('')}</g>
</svg>
`;
}
