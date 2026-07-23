/**
 * Mermaid rendering (P0.6): the whole graph with human checkpoints, loops and
 * gates highlighted; optionally overlaid with a state file's taken path,
 * current node and frontier.
 */

import type { PlanState, Trajectory } from './types.js';
import { END } from './types.js';
import { frontier, visitedPath } from './state.js';

export interface RenderOptions {
  state?: PlanState | null;
  direction?: 'TD' | 'LR';
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}

export function renderMermaid(trajectory: Trajectory, options: RenderOptions = {}): string {
  const { state } = options;
  const lines: string[] = [`flowchart ${options.direction ?? 'TD'}`];
  const humanEdges: number[] = [];
  const takenNodes = state ? new Set(visitedPath(state).filter((id) => id !== END)) : new Set<string>();
  const frontierTargets = state && state.status === 'active'
    ? new Set(frontier(trajectory, state).filter((a) => !a.blocked).map((a) => a.choice.target))
    : new Set<string>();
  let usesEnd = false;
  let edgeIndex = 0;

  for (const node of trajectory.nodes) {
    const title = firstLine(node.body);
    const label = title ? `<b>${esc(node.id)}</b><br/>${esc(title)}` : `<b>${esc(node.id)}</b>`;
    lines.push(`  ${node.id}["${label}"]`);
  }

  for (const node of trajectory.nodes) {
    for (const choice of node.choices) {
      const parts: string[] = [];
      if (choice.human) parts.push('✋');
      if (choice.loop) parts.push('↻');
      parts.push(choice.label);
      if (choice.gate) parts.push(`{${choice.gate.source}}`);
      const text = esc(parts.join(' '));
      if (choice.target === END) usesEnd = true;
      const arrow = choice.loop ? `-. "${text}" .->` : `-- "${text}" -->`;
      lines.push(`  ${node.id} ${arrow} ${choice.target}`);
      if (choice.human) humanEdges.push(edgeIndex);
      edgeIndex++;
    }
    if (node.divert) {
      if (node.divert.target === END) usesEnd = true;
      lines.push(`  ${node.id} --> ${node.divert.target}`);
      edgeIndex++;
    }
  }

  if (usesEnd) lines.push(`  ${END}(((${END})))`);

  lines.push('  classDef taken fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px;');
  lines.push('  classDef current fill:#fff59d,stroke:#f57f17,stroke-width:3px;');
  lines.push('  classDef frontier stroke:#1565c0,stroke-width:2px,stroke-dasharray:4 2;');
  if (takenNodes.size > 0) lines.push(`  class ${[...takenNodes].join(',')} taken;`);
  if (state && state.status === 'active') lines.push(`  class ${state.current} current;`);
  if (state && state.status === 'completed' && usesEnd) lines.push(`  class ${END} taken;`);
  const frontierOnly = [...frontierTargets].filter((id) => id !== END && !takenNodes.has(id) && id !== state?.current);
  if (frontierOnly.length > 0) lines.push(`  class ${frontierOnly.join(',')} frontier;`);
  for (const idx of humanEdges) {
    lines.push(`  linkStyle ${idx} stroke:#c62828,stroke-width:3px;`);
  }
  return lines.join('\n') + '\n';
}
