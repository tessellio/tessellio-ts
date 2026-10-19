/**
 * Update part parsing, validation, and assembly.
 *
 * One update arrives as one or more parts that carry the same `updateId` and
 * replicate `partCount`/`updateBytes`. A part is validated in full before it
 * can join an assembly, and a update is only handed on complete: the canvas
 * never sees a partial update.
 */

import { MAX_REGION_WIRE_BYTES, type ResyncReason } from "./op-stream";

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

export type UpdatePart = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  partIndex: number;
  partCount: number;
  updateBytes: number;
  codec: number;
  /**
   * `flags.ANCHOR` (design §5.5.2): the update's regions are absolute cell
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
  parts: number;
  anchor: boolean;
};

export type PartVerdict = { ok: true } | { ok: false; reason: ResyncReason };

/** The one screen-stream codec id. Every other id is a hard reject. */
export const CODEC_TESSELLIO = 8;

export const MAX_SURFACE_DIMENSION = 8192;
export const MAX_SURFACE_CELLS = 16_777_216;
export const MAX_UPDATE_WIRE_BYTES = 3_932_160;
export const MAX_REGIONS_PER_UPDATE = 64;
export const MAX_REGIONS_PER_PART = 32;
export const MAX_PARTS_PER_UPDATE = 8;

export const DEFAULT_ASSEMBLY_LIMITS: AssemblyLimits = {
  maxUpdateBytes: MAX_UPDATE_WIRE_BYTES,
  maxRegions: MAX_REGIONS_PER_UPDATE,
};

export type AssemblyLimits = {
  maxUpdateBytes: number;
  maxRegions: number;
};

type AssembledRegion = UpdateRegion;

type PartialUpdate = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  partCount: number;
  updateBytes: number;
  anchor: boolean;
  nextPartIndex: number;
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
 * Parse a decoded `screen.update` part.
 *
 * The shape is the generated `Update` object. A part whose
 * identity fields are missing or non-integral, or that carries even one
 * unparseable region, is rejected as a whole: dropping a region and applying
 * the rest would paint a update the host never sent.
 */
export function parseUpdatePart(raw: unknown): UpdatePart | null {
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
 * Reject a part that cannot belong to a coherent update.
 *
 * The reject vocabulary of the receiver is coarser than the field checks below,
 * so framing violations (identity fields, part identity, region payload
 * shape) map onto `PART_GAP`/`DECODE_ERROR`/`GEOMETRY_MISMATCH`/
 * `INCOMPLETE_UPDATE` — the reasons the host counts and acts on. Every check
 * runs before the part can touch an assembly, and a failure rejects the whole
 * update.
 */
export function validatePart(part: UpdatePart, limits: AssemblyLimits = DEFAULT_ASSEMBLY_LIMITS): PartVerdict {
  if (part.codec !== CODEC_TESSELLIO) {
    return { ok: false, reason: "UNKNOWN_CODEC" };
  }

  if (part.updateId < 1) {
    return { ok: false, reason: "PART_GAP" };
  }

  if (part.baseUpdateId !== 0 && part.baseUpdateId >= part.updateId) {
    return { ok: false, reason: "PART_GAP" };
  }

  if (
    part.width < 1 ||
    part.height < 1 ||
    part.width > MAX_SURFACE_DIMENSION ||
    part.height > MAX_SURFACE_DIMENSION ||
    part.width * part.height > MAX_SURFACE_CELLS
  ) {
    return { ok: false, reason: "GEOMETRY_MISMATCH" };
  }

  if (part.partIndex < 0 || part.partCount < 1 || part.partCount > MAX_PARTS_PER_UPDATE || part.partIndex >= part.partCount) {
    return { ok: false, reason: "PART_GAP" };
  }

  if (part.updateBytes < 0 || part.updateBytes > limits.maxUpdateBytes) {
    return { ok: false, reason: "INCOMPLETE_UPDATE" };
  }

  if (part.regions.length > MAX_REGIONS_PER_PART) {
    return { ok: false, reason: "DECODE_ERROR" };
  }

  for (const region of part.regions) {
    if (
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1 ||
      region.x + region.width > part.width ||
      region.y + region.height > part.height
    ) {
      return { ok: false, reason: "DECODE_ERROR" };
    }

    if (region.payload.byteLength === 0 || region.payload.byteLength > MAX_REGION_WIRE_BYTES) {
      return { ok: false, reason: "DECODE_ERROR" };
    }
  }

  if (!regionsAreOrdered(part.regions) || !regionIsDisjoint(part.regions)) {
    return { ok: false, reason: "DECODE_ERROR" };
  }

  return { ok: true };
}

/**
 * Assemble updates from their parts.
 *
 * Parts of one update must arrive as `partIndex` `0,1,2,…` on the ordered
 * stream; a different `updateId` before completion discards the partial update.
 * The sum of the part payloads must equal the update's declared `updateBytes`.
 */
export class UpdateAssembler {
  private readonly limits: AssemblyLimits;
  private partial: PartialUpdate | null = null;

  constructor(limits?: { maxUpdateBytes?: number; maxRegions?: number }) {
    this.limits = {
      maxUpdateBytes: limits?.maxUpdateBytes ?? MAX_UPDATE_WIRE_BYTES,
      maxRegions: limits?.maxRegions ?? MAX_REGIONS_PER_UPDATE,
    };
  }

  /** Drop any partial assembly, for example when the connection restarts. */
  reset(): void {
    this.partial = null;
  }

  /**
   * Feed one part. Returns a complete update, a resync decision, or nothing
   * while an assembly is still in progress.
   */
  push(part: UpdatePart): { update: AssembledUpdate | null; resync: ResyncReason | null } {
    const verdict = validatePart(part, this.limits);
    if (!verdict.ok) {
      this.partial = null;
      return { update: null, resync: verdict.reason };
    }

    const partial = this.partial;
    if (partial === null || partial.updateId !== part.updateId) {
      if (part.partIndex !== 0) {
        this.partial = null;
        return { update: null, resync: "PART_GAP" };
      }
      this.partial = {
        updateId: part.updateId,
        baseUpdateId: part.baseUpdateId,
        width: part.width,
        height: part.height,
        partCount: part.partCount,
        updateBytes: part.updateBytes,
        anchor: part.anchor === true,
        nextPartIndex: 0,
        bytes: 0,
        regions: [],
      };
    } else {
      if (
        part.partIndex !== partial.nextPartIndex ||
        part.partCount !== partial.partCount ||
        part.baseUpdateId !== partial.baseUpdateId ||
        part.width !== partial.width ||
        part.height !== partial.height ||
        part.updateBytes !== partial.updateBytes ||
        (part.anchor === true) !== partial.anchor
      ) {
        this.partial = null;
        return { update: null, resync: "PART_GAP" };
      }
    }

    const current = this.partial;
    if (current === null) {
      return { update: null, resync: null };
    }
    if (current.nextPartIndex === 0) {
      current.regions = part.regions;
      current.bytes = 0;
    } else {
      current.regions = current.regions.concat(part.regions);
    }
    for (const region of part.regions) {
      current.bytes += region.payload.byteLength;
    }
    current.nextPartIndex += 1;

    if (current.bytes > current.updateBytes || current.regions.length > this.limits.maxRegions) {
      this.partial = null;
      return { update: null, resync: "INCOMPLETE_UPDATE" };
    }

    if (current.nextPartIndex < current.partCount) {
      return { update: null, resync: null };
    }

    if (current.bytes !== current.updateBytes) {
      this.partial = null;
      return { update: null, resync: "INCOMPLETE_UPDATE" };
    }

    this.partial = null;
    return {
      update: {
        updateId: current.updateId,
        baseUpdateId: current.baseUpdateId,
        width: current.width,
        height: current.height,
        updateBytes: current.updateBytes,
        regions: current.regions,
        parts: current.partCount,
        anchor: current.anchor,
      },
      resync: null,
    };
  }
}
