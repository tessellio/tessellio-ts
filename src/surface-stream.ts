/**
 * The codec's surface stream: the codec's own half of a receiver.
 *
 * One instance drives one session's updates into one surface. It takes the
 * codec's own envelope — one part of one update — and reports what it
 * applied: the update, the part that completed it, the surface's cell count,
 * and the render latency.
 *
 * The stream knows nothing about the transport. It holds no chain epoch, no
 * acknowledgement window, and no repair request: the transport's half owns
 * those, and the two meet in the application that wires them together.
 *
 * An update is applied whole. Its parts are assembled, every region is
 * inflated and validated before the first cell is written, the regions are
 * painted, and only then is the update reported as applied. An update that
 * cannot be applied is refused whole, and the refusal names the update the
 * surface still holds.
 */

import { RegionOpsPool, decodeRegionInto, type Coverage, type ResyncReason } from "./op-stream";
import type { SurfaceCanvasRenderer } from "./surface";
import {
  UpdateAssembler,
  type AssembledUpdate,
  type UpdatePart,
  type UpdateRegion,
} from "./update-parts";

/** What the stream applied: one update, painted on the surface. */
export type SurfaceApplyReport = {
  /** The update that was applied. */
  updateId: number;
  /**
   * The index of the part that completed the update. The parts of an update
   * arrive in order, so this is the update's last part.
   */
  partIndex: number;
  /** The number of cells the surface holds after the apply. */
  appliedCellCount: number;
  /**
   * The number of cells the surface holds that the sender's reference has
   * moved past. An applied update leaves the surface equal to the reference,
   * so this is zero.
   */
  staleCells: number;
  /** Whether the surface equals the sender's reference. */
  converged: boolean;
  /** The time from the update's first part to the painted surface. */
  renderLatencyMs: number;
  /** Whether a render latency was measured. */
  hasRenderLatencyMs: boolean;
};

/** Why the stream could not apply an update. */
export type SurfaceFailureReport = {
  /**
   * `PART_GAP` — a part of the update is missing.
   *
   * `INCOMPLETE_UPDATE` — the update cannot be applied onto the state the
   * surface holds: its base is not held, its geometry does not match, or one
   * of its regions does not decode.
   */
  reason: "PART_GAP" | "INCOMPLETE_UPDATE";
  /** The update the surface holds. */
  heldUpdateId: number;
};

export type SurfaceStreamOptions = {
  /** The surface the updates are painted on. */
  renderer: SurfaceCanvasRenderer;
  /** The clock the render latency is measured against. */
  now?: () => number;
  /** Called once an update has been applied and painted. */
  onApplied?: (report: SurfaceApplyReport) => void;
  /** Called when an update could not be applied. */
  onFailure?: (failure: SurfaceFailureReport) => void;
};

/** What the stream did with the updates it was given. */
export type SurfaceStreamStats = {
  /** The updates applied and painted. */
  updatesApplied: number;
  /** The updates the stream did not apply. */
  updatesDropped: number;
  /** The refusals the stream reported. */
  failures: number;
  /** The parts ignored because they had already been applied. */
  duplicatePartsIgnored: number;
};

type ValidatedRegion = { region: UpdateRegion; ops: Uint8Array };

type QueuedUpdate = {
  update: AssembledUpdate;
  /** The clock reading when the update's first part arrived. */
  startedAtMs: number | null;
};

/** Whole updates held for painting; a burst beyond this drops the backlog. */
const READY_QUEUE_DEPTH = 2;

/** Bound on the record of applied parts. */
const APPLIED_PART_WINDOW = 512;

/**
 * The codec's own failure vocabulary, from the codec's own rejection reasons:
 * a part is missing, or the update cannot be applied onto the held state.
 */
function failureReason(reason: ResyncReason): SurfaceFailureReport["reason"] {
  return reason === "PART_GAP" ? "PART_GAP" : "INCOMPLETE_UPDATE";
}

export class SurfaceStream {
  private readonly renderer: SurfaceCanvasRenderer;
  private readonly now: () => number;
  private readonly onApplied: ((report: SurfaceApplyReport) => void) | undefined;
  private readonly onFailure: ((failure: SurfaceFailureReport) => void) | undefined;

  private readonly assembler = new UpdateAssembler();
  private readonly queue: QueuedUpdate[] = [];
  /** Reused per-update op storage and region list (no steady-state allocation). */
  private readonly opsPool = new RegionOpsPool();
  private readonly validatedRegions: ValidatedRegion[] = [];

  /** The update the surface holds; zero while it holds none. */
  private applied = 0;
  private geometry: { width: number; height: number } | null = null;
  private pumping = false;

  /** The clock reading when the assembling update's first part arrived. */
  private startedAtMs: number | null = null;
  private startedUpdateId = 0;

  /** The parts of the applied updates, for the idempotence of the codec's rules. */
  private readonly appliedParts = new Set<string>();
  private readonly appliedPartOrder: string[] = [];
  /** The parts fed to the assembly in progress. */
  private readonly pendingParts = new Set<string>();
  private pendingUpdateId = 0;

  private updatesApplied = 0;
  private updatesDropped = 0;
  private failures = 0;
  private duplicatePartsIgnored = 0;

  constructor(options: SurfaceStreamOptions) {
    this.renderer = options.renderer;
    this.now = options.now ?? (() => performance.now());
    this.onApplied = options.onApplied;
    this.onFailure = options.onFailure;
  }

  /** The update the surface holds; zero while it holds none. */
  get appliedUpdateId(): number {
    return this.applied;
  }

  /** The number of cells the surface holds. */
  get appliedCellCount(): number {
    return this.geometry === null ? 0 : this.geometry.width * this.geometry.height;
  }

  /** The number of cells the surface holds that the sender's reference moved past. */
  get staleCellCount(): number {
    return 0;
  }

  /** Whether the surface equals the sender's reference. */
  get isConverged(): boolean {
    return this.applied > 0;
  }

  get stats(): SurfaceStreamStats {
    return {
      updatesApplied: this.updatesApplied,
      updatesDropped: this.updatesDropped,
      failures: this.failures,
      duplicatePartsIgnored: this.duplicatePartsIgnored,
    };
  }

  /**
   * Apply one part of one update.
   *
   * The part is the codec's own envelope. `meta` is the caller's view of it:
   * whether the update is absolute, and the update it extends. The codec's
   * envelope settles both questions when it can; the caller's answers cover
   * what the envelope leaves open. An update is absolute when the caller
   * says so, when the part says so, or when it names no base at all.
   */
  applyPart(part: UpdatePart, meta: { anchor?: boolean; baseUpdateId?: number }): void {
    const key = `${part.updateId}:${part.partIndex}`;
    if (this.appliedParts.has(key)) {
      // Application is idempotent by (update id, part index): a part that has
      // already been applied is not applied twice.
      this.duplicatePartsIgnored += 1;
      return;
    }
    if (this.pendingUpdateId === part.updateId && this.pendingParts.has(key)) {
      // The part is already part of the assembly in progress: a re-delivery
      // of it changes nothing.
      this.duplicatePartsIgnored += 1;
      return;
    }
    if (this.pendingUpdateId !== part.updateId) {
      // Another update's assembly: the parts of the one in progress are gone.
      this.pendingParts.clear();
      this.pendingUpdateId = part.updateId;
    }
    this.pendingParts.add(key);

    if (part.partIndex === 0) {
      this.startedAtMs = this.now();
      this.startedUpdateId = part.updateId;
    }

    const anchor = this.isAnchor(part, meta);
    const { update, resync } = this.assembler.push({ ...part, anchor });
    if (resync !== null) {
      this.pendingParts.clear();
      this.updatesDropped += 1;
      this.refuse(failureReason(resync));
      return;
    }

    if (update === null) {
      // The update is still assembling: the rest of its parts are on their way.
      return;
    }

    this.pendingParts.clear();
    this.enqueue(update);
  }

  /** Whether the update is absolute: its regions are absolute cell writes. */
  private isAnchor(part: UpdatePart, meta: { anchor?: boolean; baseUpdateId?: number }): boolean {
    if (meta.anchor === true || part.anchor === true) {
      return true;
    }
    const base = meta.baseUpdateId ?? part.baseUpdateId;
    return base === 0;
  }

  /**
   * Record the parts of an applied update. A part of an applied update is
   * never applied again, whichever way it is delivered.
   */
  private recordApplied(update: AssembledUpdate): void {
    for (let index = 0; index < update.parts; index += 1) {
      const key = `${update.updateId}:${index}`;
      this.appliedParts.add(key);
      this.appliedPartOrder.push(key);
    }
    while (this.appliedPartOrder.length > APPLIED_PART_WINDOW) {
      const dropped = this.appliedPartOrder.shift();
      if (dropped !== undefined) {
        this.appliedParts.delete(dropped);
      }
    }
  }

  /**
   * Hold the update for painting. A stream that cannot keep up must not paint
   * a stale backlog: the queue is cleared whole and the update is refused.
   */
  private enqueue(update: AssembledUpdate): void {
    if (this.queue.length >= READY_QUEUE_DEPTH) {
      this.updatesDropped += this.queue.length + 1;
      this.queue.length = 0;
      this.refuse("INCOMPLETE_UPDATE");
      return;
    }

    const startedAtMs = this.startedUpdateId === update.updateId ? this.startedAtMs : null;
    this.startedAtMs = null;
    this.startedUpdateId = 0;
    this.queue.push({ update, startedAtMs });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }

    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) {
          return;
        }
        await this.applyUpdate(entry);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async applyUpdate(entry: QueuedUpdate): Promise<void> {
    const update = entry.update;
    const anchor = update.anchor;

    // A delta for an update the surface already moved past is stale, not
    // lost: it carries no information, and applying it would move the
    // surface backwards.
    if (!anchor && update.baseUpdateId !== 0 && update.updateId <= this.applied) {
      this.updatesDropped += 1;
      return;
    }

    if (anchor || update.baseUpdateId === 0) {
      // The geometry of an absolute update is authoritative.
      if (this.geometry?.width !== update.width || this.geometry?.height !== update.height) {
        this.renderer.resize(update.width, update.height);
        this.geometry = { width: update.width, height: update.height };
      }
    } else {
      if (this.geometry?.width !== update.width || this.geometry?.height !== update.height) {
        this.updatesDropped += 1;
        this.refuse("INCOMPLETE_UPDATE");
        return;
      }
      if (update.baseUpdateId !== this.applied) {
        this.updatesDropped += 1;
        this.refuse("INCOMPLETE_UPDATE");
        return;
      }
    }

    const coverage: Coverage = anchor || update.baseUpdateId === 0 ? "full" : "sparse";
    const regions = update.regions;
    const pool = this.opsPool;

    pool.beginUpdate();
    try {
      // Every region of the update is inflated and validated before the first
      // cell is written. The regions are independent slots, so the inflates
      // run concurrently: the decompressor's per-part promise overhead is a
      // large part of an absolute update's cost when the regions are walked
      // one after another.
      const results = await Promise.all(
        regions.map((region, index) => decodeRegionInto(region.payload, region, coverage, pool, index)),
      );

      // The whole update is refused on the first region that fails, in region
      // order, so the report does not depend on the completion order.
      for (const result of results) {
        if (!result.ok) {
          this.updatesDropped += 1;
          this.refuse("INCOMPLETE_UPDATE");
          return;
        }
      }

      const validated = this.validatedRegions;
      validated.length = 0;
      for (let index = 0; index < regions.length; index += 1) {
        validated.push({ region: regions[index], ops: pool.view(index) });
      }

      this.renderer.applyUpdate({ width: update.width, height: update.height }, validated);
      this.renderer.flush();
    } finally {
      pool.endUpdate();
    }

    this.applied = update.updateId;
    this.updatesApplied += 1;
    this.recordApplied(update);

    const renderLatencyMs = entry.startedAtMs === null ? 0 : Math.max(0, this.now() - entry.startedAtMs);
    this.onApplied?.({
      updateId: update.updateId,
      partIndex: update.parts - 1,
      appliedCellCount: update.width * update.height,
      staleCells: 0,
      converged: true,
      renderLatencyMs,
      hasRenderLatencyMs: renderLatencyMs > 0,
    });
  }

  /** Report an update the stream could not apply. */
  private refuse(reason: SurfaceFailureReport["reason"]): void {
    this.failures += 1;
    this.onFailure?.({ reason, heldUpdateId: this.applied });
  }
}
