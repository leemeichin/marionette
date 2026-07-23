/**
 * Sync sidecar I/O (<plan>.sync.json) — the one fs-dependent piece of tracker
 * sync, kept out of src/sync.ts so the compile import chain stays free of
 * Node built-ins and runs unmodified in the browser (docs-site playground).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { SyncSidecar } from './sync.js';

export function loadSidecar(file: string): SyncSidecar | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SyncSidecar;
  if (typeof parsed.cursor !== 'number' || parsed.cursor < 0) {
    throw new Error(`invalid sync sidecar ${file}: "cursor" must be a non-negative number`);
  }
  return parsed;
}

export function saveSidecar(file: string, sidecar: SyncSidecar): void {
  writeFileSync(file, JSON.stringify(sidecar, null, 2) + '\n');
}
