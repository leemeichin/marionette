/**
 * A serialized, multi-principal owner for one persisted runtime run.
 *
 * Wire connections deliberately bind one principal, but an agent host also
 * needs a trusted path for a human to answer an escalation. The host owns the
 * single writer and selects the principal at its trust boundary; the model
 * never supplies identity in a runtime request.
 */

import type { Trajectory } from './types.ts';
import type { RuntimePrincipal, RuntimeRequest } from './runtime-protocol.ts';
import {
  amendRuntimeSnapshot, executeRuntimeRequest,
  type RuntimeAmendOptions, type RuntimeCommandOptions,
  type RuntimeCommandResult,
  type RuntimeSnapshot,
} from './runtime.ts';
import { archiveTrajectory, commitRuntimeStore } from './runtime-store.ts';

export class RuntimeRunController {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private trajectory: Trajectory,
    private snapshot: RuntimeSnapshot,
    private readonly storeRoot: string,
  ) {}

  currentSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  currentTrajectory(): Trajectory {
    return this.trajectory;
  }

  /**
   * Refresh the in-memory view without racing commands already queued on this
   * controller. The journal remains authoritative when another trusted host
   * has committed since this instance last executed.
   */
  reload(load: () => Promise<RuntimeSnapshot>): Promise<void> {
    const pending = this.tail.then(async () => {
      this.snapshot = await load();
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  amend(
    principal: RuntimePrincipal,
    candidate: Trajectory,
    options: RuntimeAmendOptions,
  ): Promise<RuntimeCommandResult> {
    const pending = this.tail.then(async () => {
      const before = this.snapshot;
      const executed = await amendRuntimeSnapshot(
        this.trajectory,
        candidate,
        before,
        principal,
        options,
      );
      await archiveTrajectory(this.storeRoot, candidate);
      commitRuntimeStore(
        this.storeRoot,
        candidate,
        before,
        executed.snapshot,
        executed.events,
      );
      this.trajectory = candidate;
      this.snapshot = executed.snapshot;
      return executed;
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  execute(
    principal: RuntimePrincipal,
    request: RuntimeRequest,
    options: RuntimeCommandOptions = {},
  ): Promise<RuntimeCommandResult> {
    const pending = this.tail.then(async () => {
      const before = this.snapshot;
      const executed = await executeRuntimeRequest(
        this.trajectory,
        before,
        principal,
        request,
        options,
      );
      if (executed.snapshot !== before) {
        commitRuntimeStore(
          this.storeRoot,
          this.trajectory,
          before,
          executed.snapshot,
          executed.events,
        );
        this.snapshot = executed.snapshot;
      }
      return executed;
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
