/**
 * Screen-frame chunk parsing, validation, and assembly.
 *
 * One frame arrives as one or more chunks that carry the same `updateId` and
 * replicate `partCount`/`updateBytes`. A chunk is validated in full before it
 * can join an assembly, and a frame is only handed on complete: the canvas
 * never sees a partial frame.
 */

import { MAX_REGION_WIRE_BYTES, type ResyncReason } from "./screen-op";

export type UpdateRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The region's raw-DEFLATE payload. The bytes must be backed by a real
   * `ArrayBuffer` (never a `SharedArrayBuffer`), which is what the generated
   * decoder produces; the parser enforces it without copying.
   */
  payload: Uint8Array<ArrayBuffer>;
};

export type UpdateChunk = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  partIndex: number;
  partCount: number;
  updateBytes: number;
  codec: number;
  /**
   * `flags.ANCHOR` (design §5.5.2): the frame's regions are absolute cell
   * writes and may be applied onto any held state. The legacy control-lane
   * path leaves it unset.
   */
  anchor?: boolean;
  /** `flags.DUP`: a deliberate duplicate for an echo-critical object. */
  duplicate?: boolean;
  regions: UpdateRegion[];
};

export type AssembledUpdate = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  updateBytes: number;
  regions: UpdateRegion[];
  chunks: number;
  anchor: boolean;
};

export type ChunkVerdict = { ok: true } | { ok: false; reason: ResyncReason };

/** The one screen-stream codec id. Every other id is a hard reject. */
export const CODEC_TESSELLIO = 8;

export const MAX_SURFACE_DIMENSION = 8192;
export const MAX_SURFACE_CELLS = 16_777_216;
export const MAX_UPDATE_WIRE_BYTES = 3_932_160;
export const MAX_REGIONS_PER_UPDATE = 64;
export const MAX_REGIONS_PER_CHUNK = 32;
export const MAX_CHUNKS_PER_UPDATE = 8;

export const DEFAULT_ASSEMBLY_LIMITS: AssemblyLimits = {
  maxFrameBytes: MAX_UPDATE_WIRE_BYTES,
  maxRegions: MAX_REGIONS_PER_UPDATE,
};

export type AssemblyLimits = {
  maxFrameBytes: number;
  maxRegions: number;
};

type AssembledRegion = UpdateRegion;

type PartialFrame = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  partCount: number;
  updateBytes: number;
  anchor: boolean;
  nextChunkIndex: number;
  bytes: number;
  regions: AssembledRegion[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readBinary(value: unknown): Uint8Array<ArrayBuffer> | null {
  const view = (() => {
    if (value instanceof Uint8Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    return null;
  })();

  if (view === null || !(view.buffer instanceof ArrayBuffer)) {
    return null;
  }

  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function parseRegion(raw: unknown): UpdateRegion | null {
  if (!isRecord(raw)) {
    return null;
  }

  const x = readInteger(raw.x);
  const y = readInteger(raw.y);
  const width = readInteger(raw.width);
  const height = readInteger(raw.height);
  const payload = readBinary(raw.payload);

  if (x === null || y === null || width === null || height === null || payload === null) {
    return null;
  }

  return { x, y, width, height, payload };
}

/**
 * Parse a decoded `screen.frame` chunk.
 *
 * The shape is the generated `Update` object. A chunk whose
 * identity fields are missing or non-integral, or that carries even one
 * unparseable region, is rejected as a whole: dropping a region and applying
 * the rest would paint a frame the host never sent.
 */
export function parseScreenFrameChunk(raw: unknown): UpdateChunk | null {
  if (!isRecord(raw)) {
    return null;
  }

  const updateId = readInteger(raw.updateId);
  const baseUpdateId = readInteger(raw.baseUpdateId);
  const width = readInteger(raw.width);
  const height = readInteger(raw.height);
  const partIndex = readInteger(raw.partIndex);
  const partCount = readInteger(raw.partCount);
  const updateBytes = readInteger(raw.updateBytes);

  if (
    updateId === null ||
    baseUpdateId === null ||
    width === null ||
    height === null ||
    partIndex === null ||
    partCount === null ||
    updateBytes === null
  ) {
    return null;
  }

  const codec = readInteger(raw.codec) ?? 0;
  const regionsRaw = Array.isArray(raw.regions) ? raw.regions : [];
  const regions: UpdateRegion[] = [];

  for (const entry of regionsRaw) {
    const region = parseRegion(entry);
    if (!region) {
      return null;
    }
    regions.push(region);
  }

  return {
    updateId,
    baseUpdateId,
    width,
    height,
    partIndex,
    partCount,
    updateBytes,
    codec,
    anchor: raw.anchor === true,
    duplicate: raw.duplicate === true,
    regions,
  };
}

function regionIsDisjoint(regions: UpdateRegion[]): boolean {
  for (let left = 0; left < regions.length; left += 1) {
    const a = regions[left];
    for (let right = left + 1; right < regions.length; right += 1) {
      const b = regions[right];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        return false;
      }
    }
  }

  return true;
}

function regionsAreOrdered(regions: UpdateRegion[]): boolean {
  for (let index = 1; index < regions.length; index += 1) {
    const previous = regions[index - 1];
    const current = regions[index];
    if (current.y < previous.y || (current.y === previous.y && current.x <= previous.x)) {
      return false;
    }
  }

  return true;
}

/**
 * Reject a chunk that cannot belong to a coherent frame.
 *
 * The reject vocabulary of the receiver is coarser than the field checks below,
 * so framing violations (identity fields, chunk identity, region payload
 * shape) map onto `CHUNK_GAP`/`DECODE_ERROR`/`GEOMETRY_MISMATCH`/
 * `INCOMPLETE_FRAME` — the reasons the host counts and acts on. Every check
 * runs before the chunk can touch an assembly, and a failure rejects the whole
 * frame.
 */
export function validateChunk(chunk: UpdateChunk, limits: AssemblyLimits = DEFAULT_ASSEMBLY_LIMITS): ChunkVerdict {
  if (chunk.codec !== CODEC_TESSELLIO) {
    return { ok: false, reason: "UNKNOWN_CODEC" };
  }

  if (chunk.updateId < 1) {
    return { ok: false, reason: "CHUNK_GAP" };
  }

  if (chunk.baseUpdateId !== 0 && chunk.baseUpdateId >= chunk.updateId) {
    return { ok: false, reason: "CHUNK_GAP" };
  }

  if (
    chunk.width < 1 ||
    chunk.height < 1 ||
    chunk.width > MAX_SURFACE_DIMENSION ||
    chunk.height > MAX_SURFACE_DIMENSION ||
    chunk.width * chunk.height > MAX_SURFACE_CELLS
  ) {
    return { ok: false, reason: "GEOMETRY_MISMATCH" };
  }

  if (chunk.partIndex < 0 || chunk.partCount < 1 || chunk.partCount > MAX_CHUNKS_PER_UPDATE || chunk.partIndex >= chunk.partCount) {
    return { ok: false, reason: "CHUNK_GAP" };
  }

  if (chunk.updateBytes < 0 || chunk.updateBytes > limits.maxFrameBytes) {
    return { ok: false, reason: "INCOMPLETE_FRAME" };
  }

  if (chunk.regions.length > MAX_REGIONS_PER_CHUNK) {
    return { ok: false, reason: "DECODE_ERROR" };
  }

  for (const region of chunk.regions) {
    if (
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1 ||
      region.x + region.width > chunk.width ||
      region.y + region.height > chunk.height
    ) {
      return { ok: false, reason: "DECODE_ERROR" };
    }

    if (region.payload.byteLength === 0 || region.payload.byteLength > MAX_REGION_WIRE_BYTES) {
      return { ok: false, reason: "DECODE_ERROR" };
    }
  }

  if (!regionsAreOrdered(chunk.regions) || !regionIsDisjoint(chunk.regions)) {
    return { ok: false, reason: "DECODE_ERROR" };
  }

  return { ok: true };
}

/**
 * Assemble frames from their chunks.
 *
 * Chunks of one frame must arrive as `partIndex` `0,1,2,…` on the ordered
 * stream; a different `updateId` before completion discards the partial frame.
 * The sum of the chunk payloads must equal the frame's declared `updateBytes`.
 */
export class ScreenFrameAssembler {
  private readonly limits: AssemblyLimits;
  private partial: PartialFrame | null = null;

  constructor(limits?: { maxFrameBytes?: number; maxRegions?: number }) {
    this.limits = {
      maxFrameBytes: limits?.maxFrameBytes ?? MAX_UPDATE_WIRE_BYTES,
      maxRegions: limits?.maxRegions ?? MAX_REGIONS_PER_UPDATE,
    };
  }

  /** Drop any partial assembly, for example when the connection restarts. */
  reset(): void {
    this.partial = null;
  }

  /**
   * Feed one chunk. Returns a complete frame, a resync decision, or nothing
   * while an assembly is still in progress.
   */
  push(chunk: UpdateChunk): { frame: AssembledUpdate | null; resync: ResyncReason | null } {
    const verdict = validateChunk(chunk, this.limits);
    if (!verdict.ok) {
      this.partial = null;
      return { frame: null, resync: verdict.reason };
    }

    const partial = this.partial;
    if (partial === null || partial.updateId !== chunk.updateId) {
      if (chunk.partIndex !== 0) {
        this.partial = null;
        return { frame: null, resync: "CHUNK_GAP" };
      }
      this.partial = {
        updateId: chunk.updateId,
        baseUpdateId: chunk.baseUpdateId,
        width: chunk.width,
        height: chunk.height,
        partCount: chunk.partCount,
        updateBytes: chunk.updateBytes,
        anchor: chunk.anchor === true,
        nextChunkIndex: 0,
        bytes: 0,
        regions: [],
      };
    } else {
      if (
        chunk.partIndex !== partial.nextChunkIndex ||
        chunk.partCount !== partial.partCount ||
        chunk.baseUpdateId !== partial.baseUpdateId ||
        chunk.width !== partial.width ||
        chunk.height !== partial.height ||
        chunk.updateBytes !== partial.updateBytes ||
        (chunk.anchor === true) !== partial.anchor
      ) {
        this.partial = null;
        return { frame: null, resync: "CHUNK_GAP" };
      }
    }

    const current = this.partial;
    if (current === null) {
      return { frame: null, resync: null };
    }
    if (current.nextChunkIndex === 0) {
      current.regions = chunk.regions;
      current.bytes = 0;
    } else {
      current.regions = current.regions.concat(chunk.regions);
    }
    for (const region of chunk.regions) {
      current.bytes += region.payload.byteLength;
    }
    current.nextChunkIndex += 1;

    if (current.bytes > current.updateBytes || current.regions.length > this.limits.maxRegions) {
      this.partial = null;
      return { frame: null, resync: "INCOMPLETE_FRAME" };
    }

    if (current.nextChunkIndex < current.partCount) {
      return { frame: null, resync: null };
    }

    if (current.bytes !== current.updateBytes) {
      this.partial = null;
      return { frame: null, resync: "INCOMPLETE_FRAME" };
    }

    this.partial = null;
    return {
      frame: {
        updateId: current.updateId,
        baseUpdateId: current.baseUpdateId,
        width: current.width,
        height: current.height,
        updateBytes: current.updateBytes,
        regions: current.regions,
        chunks: current.partCount,
        anchor: current.anchor,
      },
      resync: null,
    };
  }
}
