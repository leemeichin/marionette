/**
 * Mermaid rendering (P0.6): the whole graph with human checkpoints, loops and
 * gates highlighted; optionally overlaid with a state file's taken path,
 * current node and frontier.
 */

import type { PlanState, Trajectory } from './types.ts';
import { END } from './types.ts';
import { frontier, visitedPath } from './state.ts';

export interface RenderOptions {
  state?: PlanState | null;
  direction?: 'TD' | 'LR';
}

/** A deliberately small terminal projection: phases and their outgoing routes. */
export function renderCompactGraph(trajectory: Trajectory): string {
  const lines: string[] = [];
  for (const node of trajectory.nodes) {
    const title = firstLine(node.body);
    lines.push(`● ${node.id}${title ? ` — ${title}` : ''}`);
    for (const choice of node.choices) {
      const marks = [choice.human ? '✋' : '', choice.ask ? '‽' : '', choice.loop ? '↻' : '']
        .filter(Boolean)
        .join(' ');
      lines.push(`  ${marks ? `${marks} ` : '→ '}${choice.label} → ${choice.target}`);
    }
    if (node.next) lines.push(`  → ${node.next.target}`);
  }
  return lines.join('\n');
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
  return line.length > 52 ? line.slice(0, 49) + '…' : line;
}

function wrapLabel(text: string, width = 30): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line += (line ? ' ' : '') + word;
    }
  }
  if (line) lines.push(line);
  return lines.map(esc).join('<br/>');
}

export async function renderMermaid(
  trajectory: Trajectory,
  options: RenderOptions = {},
): Promise<string> {
  const { state } = options;
  const lines: string[] = [
    '%%{init: {"theme":"base","flowchart":{"curve":"basis","htmlLabels":true,"nodeSpacing":70,"rankSpacing":90},"themeVariables":{"background":"#f5f5f5","primaryColor":"#ffffff","primaryTextColor":"#303030","primaryBorderColor":"#5f5f5f","lineColor":"#5f5f5f","fontFamily":"ui-monospace, SFMono-Regular, Menlo, monospace"}}}%%',
    `flowchart ${options.direction ?? 'TD'}`,
  ];
  const humanEdges: number[] = [];
  const askEdges: number[] = [];
  const takenNodes = state ? new Set(visitedPath(state).filter((id) => id !== END)) : new Set<string>();
  const frontierTargets = state && state.status === 'active'
    ? new Set((await frontier(trajectory, state)).filter((a) => !a.blocked).map((a) => a.choice.target))
    : new Set<string>();
  let usesEnd = false;
  let edgeIndex = 0;

  for (const node of trajectory.nodes) {
    const title = firstLine(node.body);
    const label = title ? `<b>${esc(node.id)}</b><br/>${wrapLabel(title, 28)}` : `<b>${esc(node.id)}</b>`;
    lines.push(`  ${node.id}["${label}"]`);
  }

  for (const node of trajectory.nodes) {
    for (const choice of node.choices) {
      const parts: string[] = [];
      if (choice.human) parts.push('✋');
      if (choice.ask) parts.push('‽');
      if (choice.loop) parts.push('↻');
      parts.push(choice.label);
      if (choice.gate) parts.push(`{${choice.gate.source}}`);
      const text = wrapLabel(parts.join(' '));
      if (choice.target === END) usesEnd = true;
      const arrow = choice.loop ? `-. "${text}" .->` : `-- "${text}" -->`;
      lines.push(`  ${node.id} ${arrow} ${choice.target}`);
      if (choice.human) humanEdges.push(edgeIndex);
      if (choice.ask) askEdges.push(edgeIndex);
      edgeIndex++;
    }
    if (node.next) {
      if (node.next.target === END) usesEnd = true;
      lines.push(`  ${node.id} --> ${node.next.target}`);
      edgeIndex++;
    }
  }

  if (usesEnd) lines.push(`  ${END}(((${END})))`);

  lines.push('  classDef default fill:#ffffff,color:#303030,stroke:#5f5f5f,stroke-width:1.5px;');
  lines.push('  classDef taken fill:#dcebea,color:#303030,stroke:#176b63,stroke-width:2px;');
  lines.push('  classDef current fill:#ffffff,color:#303030,stroke:#3f6f00,stroke-width:3px;');
  lines.push('  classDef frontier stroke:#006a72,stroke-width:2px,stroke-dasharray:5 3;');
  if (takenNodes.size > 0) lines.push(`  class ${[...takenNodes].join(',')} taken;`);
  if (state && state.status === 'active') lines.push(`  class ${state.current} current;`);
  if (state && state.status === 'completed' && usesEnd) lines.push(`  class ${END} taken;`);
  const frontierOnly = [...frontierTargets].filter((id) => id !== END && !takenNodes.has(id) && id !== state?.current);
  if (frontierOnly.length > 0) lines.push(`  class ${frontierOnly.join(',')} frontier;`);
  for (const idx of humanEdges) {
    lines.push(`  linkStyle ${idx} stroke:#7d3e80,stroke-width:2.5px;`);
  }
  for (const idx of askEdges) {
    lines.push(`  linkStyle ${idx} stroke:#9a6700,stroke-width:2.5px;`);
  }
  return lines.join('\n') + '\n';
}
