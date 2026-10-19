/**
 * Screen-frame op-stream decoding and coverage validation.
 *
 * A region payload carries a raw DEFLATE stream (RFC 1951) whose decompressed
 * bytes are an op stream: `ROW`, `SPAN`, `FILL`, `END`, all little-endian. One
 * grammar implementation walks a stream exactly once: {@link walkOpStream}
 * enforces every rule (and, when a target is supplied, writes the runs), so the
 * validation pass and the application pass cannot diverge.
 *
 * A frame is validated as a whole before a single cell is written, and the
 * walker never allocates per op: the earlier shape — a generator that allocated
 * one object per op and was walked twice — cost ~250 ns per op, which a 50 k-op
 * 1080p reset paid twice and which the conformance corpus (≤ 512×512) could not
 * see.
 */

/**
 * Receiver-side rejection vocabulary. These names travel on the wire in
 * `screen.frame.resync.reason`, which is the only receiver signal the platform
 * aggregates.
 */
export const RESYNC_REASONS = [
  "BASE_MISMATCH",
  "INCOMPLETE_FRAME",
  "DECODE_ERROR",
  "COVERAGE_INVALID",
  "UNKNOWN_CODEC",
  "QUEUE_OVERFLOW",
  "GEOMETRY_MISMATCH",
  "CHUNK_GAP",
] as const;

export type ResyncReason = (typeof RESYNC_REASONS)[number];

export type DecodeResult =
  | { ok: true }
  | { ok: false; reason: Extract<ResyncReason, "DECODE_ERROR" | "COVERAGE_INVALID"> };

/** Decompressed op stream bound: 1 MiB. */
export const MAX_REGION_OPS_BYTES = 1_048_576;

/** Compressed region payload bound: 256 KiB. */
export const MAX_REGION_WIRE_BYTES = 262_144;

export const OP_END = 0x00;
export const OP_ROW = 0x01;
export const OP_SPAN = 0x02;
export const OP_FILL = 0x03;

export type RegionBox = { width: number; height: number };
export type Coverage = "full" | "sparse";

/** Shared verdicts: the walk is hot, so a failure does not allocate. */
const VERDICT_OK: DecodeResult = { ok: true };
const VERDICT_DECODE: DecodeResult = { ok: false, reason: "DECODE_ERROR" };
const VERDICT_COVERAGE: DecodeResult = { ok: false, reason: "COVERAGE_INVALID" };

/**
 * Walk one region's op stream: parse it, enforce the §4.3 grammar rules and
 * the mode's coverage rule, and write every run into `target` when one is
 * supplied.
 *
 * `target` writes are selected by the target view's type: `Uint16Array` writes
 * raw the 16-bit cell format words and clips runs to the target's length (`applyOps`), while
 * `Uint32Array`/`Uint8ClampedArray` write packed RGBA — the little-endian fast
 * path and the byte-order fallback. Those RGBA targets must supply `lut`.
 * A `null` target validates without writing, which is how a frame is rejected
 * before its first cell is written.
 *
 * The verdict is one of the three shared {@link DecodeResult} objects; the walk
 * allocates nothing.
 */
export function walkOpStream(
  ops: Uint8Array,
  region: RegionBox,
  coverage: Coverage,
  target: Uint16Array | Uint32Array | Uint8ClampedArray | null,
  targetStride: number,
  targetOrigin: number,
  lut: Uint32Array | null,
): DecodeResult {
  const width = region.width;
  const height = region.height;
  if (width <= 0 || height <= 0) {
    return VERDICT_DECODE;
  }

  const full = coverage === "full";
  const length = ops.length;
  // Operands are little-endian u16 at arbitrary offsets; the unaligned reads
  // a DataView allows measured 1.6–2.3× faster than assembling them from two
  // byte loads, on both the header and the literal-cell loops.
  const view = new DataView(ops.buffer, ops.byteOffset, ops.byteLength);
  const u16 = target instanceof Uint16Array ? target : null;
  const u32 = target instanceof Uint32Array ? target : null;
  const bytes = target instanceof Uint8ClampedArray ? target : null;
  if ((u32 !== null || bytes !== null) && lut === null) {
    return VERDICT_DECODE;
  }
  const table = lut === null ? EMPTY_LUT : lut;
  const u16Length = u16 === null ? 0 : u16.length;

  let index = 0;
  let row = -1;
  let previousRow = -1;
  // The row's end so far. Zero means "no run written on this row yet", which
  // is what the ascending-run rule and the full-coverage rule both need: the
  // first run of a row may start anywhere (sparse) or at column 0 (full).
  let rowEnd = 0;

  for (;;) {
    if (index >= length) {
      return VERDICT_DECODE;
    }

    const op = ops[index];
    index += 1;

    if (op === OP_END) {
      if (index !== length) {
        return VERDICT_DECODE;
      }
      if (full && (previousRow !== height - 1 || rowEnd !== width)) {
        return VERDICT_COVERAGE;
      }
      return VERDICT_OK;
    }

    if (op === OP_ROW) {
      if (index + 2 > length) {
        return VERDICT_DECODE;
      }
      const next = view.getUint16(index, true);
      index += 2;
      if (next >= height) {
        return VERDICT_DECODE;
      }
      if (next <= row) {
        return VERDICT_DECODE;
      }
      if (full) {
        if (previousRow >= 0 && rowEnd !== width) {
          return VERDICT_COVERAGE;
        }
        if (next !== previousRow + 1) {
          return VERDICT_COVERAGE;
        }
        previousRow = next;
      }
      row = next;
      rowEnd = 0;
      continue;
    }

    if (op === OP_SPAN) {
      if (row < 0) {
        return VERDICT_DECODE;
      }
      if (index + 4 > length) {
        return VERDICT_DECODE;
      }
      // One 32-bit read yields both u16 operands (x, count).
      const header = view.getUint32(index, true);
      const x = header & 0xffff;
      const count = header >>> 16;
      index += 4;
      if (count < 1 || x + count > width) {
        return VERDICT_DECODE;
      }
      const end = index + count * 2;
      if (end > length) {
        return VERDICT_DECODE;
      }
      if (rowEnd !== 0 && x < rowEnd) {
        return VERDICT_DECODE;
      }
      if (full && x !== rowEnd) {
        return VERDICT_COVERAGE;
      }

      if (u32 !== null) {
        const start = targetOrigin + row * targetStride + x;
        let pointer = index;
        for (let cell = 0; cell < count; cell += 1) {
          u32[start + cell] = table[view.getUint16(pointer, true)];
          pointer += 2;
        }
      } else if (u16 !== null) {
        const start = targetOrigin + row * targetStride + x;
        let pointer = index;
        for (let cell = 0; cell < count; cell += 1) {
          const position = start + cell;
          if (position >= 0 && position < u16Length) {
            u16[position] = view.getUint16(pointer, true);
          }
          pointer += 2;
        }
      } else if (bytes !== null) {
        const start = targetOrigin + row * targetStride + x;
        let pointer = index;
        for (let cell = 0; cell < count; cell += 1) {
          const packedValue = table[view.getUint16(pointer, true)];
          const offset = (start + cell) * 4;
          bytes[offset] = packedValue & 0xff;
          bytes[offset + 1] = (packedValue >>> 8) & 0xff;
          bytes[offset + 2] = (packedValue >>> 16) & 0xff;
          bytes[offset + 3] = 0xff;
          pointer += 2;
        }
      }

      index = end;
      rowEnd = x + count;
      continue;
    }

    if (op === OP_FILL) {
      if (row < 0) {
        return VERDICT_DECODE;
      }
      if (index + 6 > length) {
        return VERDICT_DECODE;
      }
      // One 32-bit read for (x, count), one u16 for the value.
      const header = view.getUint32(index, true);
      const x = header & 0xffff;
      const count = header >>> 16;
      const value = view.getUint16(index + 4, true);
      index += 6;
      if (count < 1 || x + count > width) {
        return VERDICT_DECODE;
      }
      if (rowEnd !== 0 && x < rowEnd) {
        return VERDICT_DECODE;
      }
      if (full && x !== rowEnd) {
        return VERDICT_COVERAGE;
      }

      if (u32 !== null) {
        const start = targetOrigin + row * targetStride + x;
        const packed = table[value];
        // Short runs are cheaper as a plain store loop; `fill` wins from
        // about two dozen cells up (measured on the reset scenes' mix).
        if (count < 24) {
          for (let cell = 0; cell < count; cell += 1) {
            u32[start + cell] = packed;
          }
        } else {
          u32.fill(packed, start, start + count);
        }
      } else if (u16 !== null) {
        let start = targetOrigin + row * targetStride + x;
        const end = start + count < u16Length ? start + count : u16Length;
        if (start < 0) {
          start = 0;
        }
        for (; start < end; start += 1) {
          u16[start] = value;
        }
      } else if (bytes !== null) {
        const packedValue = table[value];
        const start = targetOrigin + row * targetStride + x;
        for (let cell = 0; cell < count; cell += 1) {
          const offset = (start + cell) * 4;
          bytes[offset] = packedValue & 0xff;
          bytes[offset + 1] = (packedValue >>> 8) & 0xff;
          bytes[offset + 2] = (packedValue >>> 16) & 0xff;
          bytes[offset + 3] = 0xff;
        }
      }

      rowEnd = x + count;
      continue;
    }

    return VERDICT_DECODE;
  }
}

const EMPTY_LUT = new Uint32Array(1);
const EMPTY_BYTES = new Uint8Array(0);

/**
 * Validate one decompressed op stream.
 *
 * Grammar rules apply to every frame: strictly increasing `ROW` order, a
 * `ROW` before the first writing op, `len >= 1`, `x + len <= width`, and
 * ascending non-overlapping runs within a row. On a reset frame
 * (`coverage === "full"`) every row `0..height-1` must be written exactly
 * once, contiguously from column `0` to column `width-1`.
 */
export function validateOpStream(ops: Uint8Array, region: RegionBox, coverage: Coverage): DecodeResult {
  return walkOpStream(ops, region, coverage, null, 0, 0, null);
}

/**
 * Apply a validated op stream into an the 16-bit cell format target view. `target` is
 * row-major with the caller-supplied `targetStride`; `region.x`/`region.y` are
 * the region's absolute origin inside that target, and runs that fall outside
 * the target are clipped.
 *
 * The stream is validated while it is applied ({@link walkOpStream}); a
 * malformed stream throws rather than writing the rest of a frame, which is
 * why production callers validate first and pass the op bytes on.
 */
export function applyOps(
  ops: Uint8Array,
  region: { x: number; y: number; width: number; height: number },
  target: Uint16Array,
  targetStride: number,
): void {
  const verdict = walkOpStream(
    ops,
    region,
    "sparse",
    target,
    targetStride,
    region.y * targetStride + region.x,
    null,
  );
  if (!verdict.ok) {
    throw new Error("malformed op stream");
  }
}

type DecompressionStreamCtor = new (format: CompressionFormat) => DecompressionStream;

/**
 * View a wire payload as bytes a `WritableStream` accepts, without copying.
 * A `SharedArrayBuffer`-backed view cannot be written to the decompressor, so
 * it is the one case that copies; the wire decoder never produces one.
 */
function toStreamBytes(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.buffer instanceof ArrayBuffer) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return new Uint8Array(payload);
}

/**
 * Inflate a region payload with a hard output bound, handing each decompressed
 * chunk to `append`. `append` returning `false` aborts the stream (the region
 * cap was exceeded, or the caller ran out of storage).
 *
 * Returns `false` for every failure (invalid DEFLATE, output past `limit`, the
 * cap abort, or a runtime without a raw-DEFLATE decompressor). There is
 * deliberately no pure-JS fallback: a receiver that cannot inflate reports a
 * decode error and resynchronizes instead of skipping the frame silently. The
 * browser floor for this decoder is the one that ships
 * `DecompressionStream("deflate-raw")`.
 */
async function inflateRegion(
  payload: Uint8Array<ArrayBuffer>,
  limit: number,
  append: (chunk: Uint8Array) => boolean,
): Promise<boolean> {
  const Ctor: DecompressionStreamCtor | null =
    typeof DecompressionStream === "function" ? DecompressionStream : null;
  if (!Ctor) {
    return false;
  }

  const stream = new Ctor("deflate-raw");
  const writer = stream.writable.getWriter();
  // Failures surface through the reader; the write promise must not become an
  // unhandled rejection when the stream errors mid-write.
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > limit || !append(value)) {
        await reader.cancel();
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Decompress and validate one region payload.
 *
 * The validated op bytes are handed to `sink.ops` for the application pass, so
 * the compressed payload is inflated exactly once and the frame can be
 * validated as a whole before the first write.
 *
 * This entry point owns its output buffer and is meant for single-region work
 * (tests, the corpus consumer). The receiver's frame path decodes through a
 * {@link RegionOpsPool} so a steady stream allocates nothing and the regions of
 * one frame can be inflated concurrently.
 */
export async function decompressAndValidate(
  payload: Uint8Array,
  region: RegionBox,
  coverage: Coverage,
  sink: { ops: Uint8Array | null },
): Promise<DecodeResult> {
  sink.ops = null;

  if (payload.byteLength === 0 || payload.byteLength > MAX_REGION_WIRE_BYTES) {
    return VERDICT_DECODE;
  }
  if (region.width <= 0 || region.height <= 0) {
    return VERDICT_DECODE;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const ok = await inflateRegion(toStreamBytes(payload), MAX_REGION_OPS_BYTES, (chunk) => {
    total += chunk.byteLength;
    chunks.push(chunk);
    return true;
  });
  if (!ok) {
    return VERDICT_DECODE;
  }

  const ops = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    ops.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const verdict = validateOpStream(ops, region, coverage);
  if (!verdict.ok) {
    return verdict;
  }

  sink.ops = ops;
  return VERDICT_OK;
}

type PoolSlot = { buffer: Uint8Array; length: number; retained: boolean };

/** Slots retained across frames are capped so a hostile frame cannot pin RAM. */
const RETAINED_POOL_BYTES = 8 * 1024 * 1024;

/**
 * Per-frame storage for decompressed region op streams.
 *
 * One slot per region index, reused across frames: `beginFrame` resets the
 * lengths, {@link append} grows a slot to fit what the inflater produces
 * (bounded by {@link MAX_REGION_OPS_BYTES} per region), and {@link view} hands
 * the bytes to the validator and the renderer. Slots are per region, so a
 * frame's regions can be inflated concurrently — each writes to its own slot.
 *
 * Retention is bounded by {@link RETAINED_POOL_BYTES}: a frame whose op bytes
 * exceed it keeps its slots for that frame only and releases them at
 * {@link endFrame}.
 */
export class RegionOpsPool {
  private readonly slots: PoolSlot[] = [];
  private retainedBytes = 0;

  /** Start a frame: every slot restarts empty. */
  beginFrame(): void {
    for (const slot of this.slots) {
      slot.length = 0;
    }
  }

  /**
   * Append one decompressed chunk to `slot`. Returns `false` when the region
   * would exceed {@link MAX_REGION_OPS_BYTES}.
   */
  append(slot: number, chunk: Uint8Array): boolean {
    let entry = this.slots[slot];
    if (entry === undefined) {
      entry = { buffer: EMPTY_BYTES, length: 0, retained: false };
      this.slots[slot] = entry;
    }

    const needed = entry.length + chunk.byteLength;
    if (needed > MAX_REGION_OPS_BYTES) {
      return false;
    }
    if (needed > entry.buffer.byteLength) {
      let capacity = entry.buffer.byteLength === 0 ? 4096 : entry.buffer.byteLength;
      while (capacity < needed) {
        capacity *= 2;
      }
      const retainedTotal = this.retainedBytes - (entry.retained ? entry.buffer.byteLength : 0) + capacity;
      const buffer = new Uint8Array(capacity);
      if (entry.length > 0) {
        buffer.set(entry.buffer.subarray(0, entry.length));
      }
      if (entry.retained) {
        this.retainedBytes -= entry.buffer.byteLength;
      }
      entry.buffer = buffer;
      entry.retained = retainedTotal <= RETAINED_POOL_BYTES;
      if (entry.retained) {
        this.retainedBytes += capacity;
      }
    }

    entry.buffer.set(chunk, entry.length);
    entry.length = needed;
    return true;
  }

  /** The bytes appended for `slot` in the frame in progress. */
  view(slot: number): Uint8Array {
    const entry = this.slots[slot];
    return entry === undefined ? EMPTY_BYTES : entry.buffer.subarray(0, entry.length);
  }

  /** Release the slots an oversized frame allocated for its own use only. */
  endFrame(): void {
    for (const slot of this.slots) {
      if (!slot.retained) {
        slot.buffer = EMPTY_BYTES;
      }
      slot.length = 0;
    }
  }
}

/**
 * Decode one region of a frame into `pool`: bounded inflate into the region's
 * slot, then op validation in the frame's coverage mode.
 *
 * `pool.view(slot)` holds the validated op bytes when the result is ok. The
 * per-region side effect (the slot) makes this safe to run for every region of
 * a frame concurrently.
 */
export async function decodeRegionInto(
  payload: Uint8Array,
  region: RegionBox,
  coverage: Coverage,
  pool: RegionOpsPool,
  slot: number,
): Promise<DecodeResult> {
  if (payload.byteLength === 0 || payload.byteLength > MAX_REGION_WIRE_BYTES) {
    return VERDICT_DECODE;
  }
  if (region.width <= 0 || region.height <= 0) {
    return VERDICT_DECODE;
  }

  const ok = await inflateRegion(toStreamBytes(payload), MAX_REGION_OPS_BYTES, (chunk) =>
    pool.append(slot, chunk),
  );
  if (!ok) {
    return VERDICT_DECODE;
  }

  return validateOpStream(pool.view(slot), region, coverage);
}
