import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compile.ts';
import {
  WalkError,
  advance,
  frontier,
  initState,
  observe,
  takeChoice,
} from '../src/state.ts';
import type { PlanState, Trajectory, Value } from '../src/types.ts';
import { SPEC_VERSION } from '../src/types.ts';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

interface WalkStep {
  choose?: string;
  advance?: boolean;
  observe?: { name: string; value: Value };
  elapsed?: number;
  actor?: string;
  rationale?: string;
}

interface WalkCase {
  case: string;
  plan: string;
  steps: WalkStep[];
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const referenceFile = join(repositoryRoot, 'spec', 'parity', 'reference.json');
const graphCasesFile = join(repositoryRoot, 'spec', 'conformance', 'graph', 'cases.json');
const walkerCasesDirectory = join(repositoryRoot, 'spec', 'conformance', 'cases');
const baseTime = '2026-01-01T00:00:00.000Z';

const command = process.argv[2];

switch (command) {
  case 'capture':
    process.stdout.write(JSON.stringify(await capture(), null, 2) + '\n');
    break;
  case 'manifest':
    process.stdout.write(JSON.stringify(referenceManifest(await capture()), null, 2) + '\n');
    break;
  case 'check-reference':
    await checkReference();
    break;
  case 'compare': {
    const marker = process.argv.indexOf('--candidate');
    const candidate = marker >= 0 ? process.argv[marker + 1] : undefined;
    if (!candidate) {
      process.stderr.write(
        'Racket parity candidate is absent. Pass --candidate <packet.json> after the human implementation gate.\n',
      );
      process.exitCode = 2;
      break;
    }
    await compareFile(join(process.cwd(), candidate), 'Racket candidate');
    break;
  }
  default:
    process.stderr.write(
      'usage: parity.ts capture | manifest | check-reference | compare --candidate <packet.json>\n',
    );
    process.exitCode = 2;
}

async function capture(): Promise<Json> {
  return {
    spec: 'marionette-parity/0.1',
    reference: {
      implementation: 'typescript+swi',
      trajectorySpec: SPEC_VERSION,
      baseTime,
    },
    diagnostics: await captureDiagnostics(),
    trajectories: await captureTrajectories(),
    walkers: await captureWalkers(),
  };
}

async function captureDiagnostics(): Promise<Json[]> {
  const cases = JSON.parse(await readFile(graphCasesFile, 'utf8')) as Array<{
    case: string;
    plan: string;
  }>;
  const directory = dirname(graphCasesFile);
  const packets: Json[] = [];
  for (const item of cases) {
    const file = join(directory, item.plan);
    const plan = relative(repositoryRoot, file);
    const result = await compile(await readFile(file, 'utf8'), { file: plan });
    const findings = result.diagnostics
      .map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        line: diagnostic.line ?? null,
      }))
      .sort((left, right) =>
        left.code.localeCompare(right.code) ||
        (left.line ?? 0) - (right.line ?? 0));
    packets.push({ case: item.case, plan, findings });
  }
  return packets;
}

async function captureTrajectories(): Promise<Json[]> {
  const cases = [
    { case: 'smallest-plan', plan: 'examples/build_mvp.mar' },
    { case: 'complete-surface', plan: 'tests/fixtures/kitchen_sink.mar' },
  ];
  const packets: Json[] = [];
  for (const item of cases) {
    const result = await compile(
      await readFile(join(repositoryRoot, item.plan), 'utf8'),
      { file: item.plan },
    );
    if (!result.trajectory) {
      throw new Error(`reference trajectory did not compile: ${item.plan}`);
    }
    packets.push({
      ...item,
      trajectory: normalizeTrajectory(result.trajectory),
    });
  }
  return packets;
}

async function captureWalkers(): Promise<Json[]> {
  const files = (await readdir(walkerCasesDirectory))
    .filter((file) => file.endsWith('.json'))
    .sort();
  const packets: Json[] = [];
  for (const file of files) {
    const item = JSON.parse(
      await readFile(join(walkerCasesDirectory, file), 'utf8'),
    ) as WalkCase;
    const result = await compile(
      await readFile(join(repositoryRoot, item.plan), 'utf8'),
      { file: item.plan },
    );
    if (!result.ok || !result.trajectory) {
      throw new Error(`walker fixture did not compile: ${item.plan}`);
    }
    packets.push(await runWalkCase(item, result.trajectory));
  }
  return packets;
}

async function runWalkCase(item: WalkCase, trajectory: Trajectory): Promise<Json> {
  let state = await initState(trajectory, 'system', baseTime);
  const observations: Json[] = [
    await projectObservation('initial', 'ok', trajectory, state, baseTime),
  ];

  for (const [index, step] of item.steps.entries()) {
    const at = new Date(
      Date.parse(baseTime) + (step.elapsed ?? 0) * 1000,
    ).toISOString();
    const options = {
      actor: step.actor ?? 'agent',
      rationale: step.rationale,
      at,
    };
    try {
      if (step.choose !== undefined) {
        state = await takeChoice(trajectory, state, step.choose, options);
      } else if (step.advance) {
        state = await advance(trajectory, state, options);
      } else if (step.observe) {
        state = await observe(
          trajectory,
          state,
          step.observe.name,
          step.observe.value,
          options,
        );
      }
      observations.push(
        await projectObservation(index, 'ok', trajectory, state, at),
      );
    } catch (error) {
      if (!(error instanceof WalkError)) throw error;
      observations.push(
        await projectObservation(index, 'refused', trajectory, state, at, error.code),
      );
    }
  }

  return {
    case: item.case,
    plan: item.plan,
    observations,
  };
}

async function projectObservation(
  step: 'initial' | number,
  outcome: 'ok' | 'refused',
  trajectory: Trajectory,
  state: PlanState,
  at: string,
  code?: string,
): Promise<Json> {
  const projected: Record<string, Json> = {
    step,
    outcome,
    state: {
      version: state.version,
      hash: state.hash,
      status: state.status,
      current: state.current,
      variables: structuredClone(state.variables) as unknown as Json,
      pendingObservations: [...state.pendingObservations],
      pendingEntry: state.pendingEntry,
      activationStartedAt: state.activationStartedAt,
      observationCount: state.observations.length,
      lastObservation: state.observations.at(-1) ?? null,
      taken: [...state.taken],
      logCount: state.log.length,
      lastLog: state.log.at(-1) ?? null,
    } as unknown as Json,
    frontier: (await frontier(trajectory, state, { at })).map((item) => ({
      id: item.choice.id,
      blockedCode: item.blockedCode,
    })),
  };
  if (code !== undefined) projected['code'] = code;
  return projected;
}

function normalizeTrajectory(value: unknown): Json {
  if (value === null || typeof value !== 'object') return value as Json;
  if (Array.isArray(value)) return value.map(normalizeTrajectory);
  const normalized: Record<string, Json> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'line' || key === 'source' || child === undefined) continue;
    normalized[key] = normalizeTrajectory(child);
  }
  return normalized;
}

async function compareFile(file: string, label: string): Promise<void> {
  let candidate: Json;
  try {
    candidate = JSON.parse(await readFile(file, 'utf8')) as Json;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(
        `${label} is absent at ${file}. The Racket candidate is expected only after the human implementation gate.\n`,
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const expected = await capture();
  if (!isDeepStrictEqual(candidate, expected)) {
    const difference = firstDifference(expected, candidate);
    process.stderr.write(`${label} differs at ${difference}.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${label} matches ${referenceFile}.\n`);
}

async function checkReference(): Promise<void> {
  const expected = JSON.parse(await readFile(referenceFile, 'utf8')) as Json;
  const actual = referenceManifest(await capture());
  if (!isDeepStrictEqual(actual, expected)) {
    process.stderr.write(
      `frozen TypeScript/SWI reference differs at ${firstDifference(expected, actual)}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`frozen TypeScript/SWI reference matches ${referenceFile}.\n`);
}

function referenceManifest(packet: Json): Json {
  if (packet === null || Array.isArray(packet) || typeof packet !== 'object') {
    throw new Error('parity packet must be an object');
  }
  const caseDigests = (key: 'diagnostics' | 'trajectories' | 'walkers'): Json[] => {
    const cases = packet[key];
    if (!Array.isArray(cases)) throw new Error(`parity packet ${key} must be an array`);
    return cases.map((item) => {
      if (item === null || Array.isArray(item) || typeof item !== 'object') {
        throw new Error(`parity packet ${key} item must be an object`);
      }
      return {
        case: String(item['case']),
        sha256: digest(item),
      };
    });
  };
  return {
    spec: 'marionette-parity-reference/0.1',
    packetSpec: packet['spec'] as Json,
    packetSha256: digest(packet),
    diagnostics: caseDigests('diagnostics'),
    trajectories: caseDigests('trajectories'),
    walkers: caseDigests('walkers'),
  };
}

function digest(value: Json): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function firstDifference(expected: Json, actual: Json, path = '$'): string {
  if (isDeepStrictEqual(expected, actual)) return path;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  ) {
    return path;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return path;
    if (expected.length !== actual.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      if (!isDeepStrictEqual(expected[index], actual[index])) {
        return firstDifference(expected[index]!, actual[index]!, `${path}[${index}]`);
      }
    }
    return path;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    if (!(key in expected) || !(key in actual)) return `${path}.${key}`;
    if (!isDeepStrictEqual(expected[key], actual[key])) {
      return firstDifference(expected[key]!, actual[key]!, `${path}.${key}`);
    }
  }
  return path;
}
