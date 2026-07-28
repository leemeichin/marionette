import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/compile.js';
import { frontier, initState } from '../src/state.js';

const source = readFileSync(new URL('../examples/paas_replatform.mar', import.meta.url), 'utf8');
const samples = 25;

const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
  const started = performance.now();
  const value = await work();
  return [value, performance.now() - started];
};

const [coldResult, coldCompileMs] = await timed(() =>
  compile(source, { file: 'examples/paas_replatform.mar' }));
if (!coldResult.ok || !coldResult.trajectory) {
  throw new Error(coldResult.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
}

const warmCompile: number[] = [];
for (let index = 0; index < samples; index++) {
  const [, elapsed] = await timed(() =>
    compile(source, { file: 'examples/paas_replatform.mar' }));
  warmCompile.push(elapsed);
}

const [state, initMs] = await timed(() =>
  initState(coldResult.trajectory!, 'benchmark', '2026-01-01T00:00:00.000Z'));
const frontierSamples: number[] = [];
for (let index = 0; index < samples; index++) {
  const [, elapsed] = await timed(() =>
    frontier(coldResult.trajectory!, state, { at: '2026-01-01T00:00:00.000Z' }));
  frontierSamples.push(elapsed);
}

const summary = (values: number[]) => ({
  meanMs: values.reduce((total, value) => total + value, 0) / values.length,
  minMs: Math.min(...values),
  maxMs: Math.max(...values),
  samples: values.length,
});

console.log(JSON.stringify({
  note: 'Measurement only; no pass/fail threshold.',
  plan: 'examples/paas_replatform.mar',
  coldCompileMs,
  warmCompile: summary(warmCompile),
  warmWalkerInitMs: initMs,
  warmFrontier: summary(frontierSamples),
}, null, 2));
