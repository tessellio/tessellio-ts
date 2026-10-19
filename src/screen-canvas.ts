/**
 * the 16-bit cell format → RGBA canvas rendering for the interactive screen stream.
 *
 * The renderer owns one canvas-sized scratch buffer and one `ImageData` for
 * the canvas' whole lifetime. Applied regions are painted into the scratch
 * through a 64 Ki entry the 16-bit cell format → packed-RGBA lookup table, and `flush()`
 * writes the merged dirty rectangles to the canvas with one `putImageData`
 * per rectangle.
 *
 * Region application walks the validated op stream once ({@link walkOpStream})
 * and writes straight into the scratch view: the little-endian fast path
 * through a `Uint32Array` view of the scratch plus the LUT, and a documented
 * four-byte-per-cell fallback for a big-endian host.
 */

import { walkOpStream } from "./screen-op";

export type RgbaRect = { x: number; y: number; width: number; height: number };

export type ByteOrder = "little" | "big";

export const RGB565_LUT_SIZE = 65_536;

export type RenderRegion = {
  region: { x: number; y: number; width: number; height: number };
  ops: Uint8Array;
};

let byteOrderOverride: ByteOrder | null = null;
let rgbaLut: Uint32Array | null = null;

/**
 * Test seam for the big-endian fallback path: the probe below cannot be
 * influenced on a little-endian host, so the endianness test forces it here.
 * Production code never calls this.
 */
export function setRgb565ByteOrderForTest(order: ByteOrder | null): void {
  byteOrderOverride = order;
}

/** Probe the host byte order once; the probe drives the fast `Uint32Array` path. */
export function detectByteOrder(): ByteOrder {
  const probe = new Uint8Array(4);
  new Uint32Array(probe.buffer)[0] = 0x0102_0304;
  return probe[0] === 0x04 ? "little" : "big";
}

function resolveByteOrder(): ByteOrder {
  return byteOrderOverride ?? detectByteOrder();
}

/**
 * Build the the 16-bit cell format → RGBA lookup table.
 *
 * Each entry is the packed 32-bit value that, read as bytes on a
 * little-endian host, is `[R, G, B, 255]`; the fast path stores that value
 * directly into the `Uint32Array` view of the scratch, and the big-endian
 * fallback unpacks its bytes in order.
 */
export function buildRgb565Lut(): Uint32Array {
  const lut = new Uint32Array(RGB565_LUT_SIZE);

  for (let value = 0; value < RGB565_LUT_SIZE; value += 1) {
    const red = (value >> 11) & 0x1f;
    const green = (value >> 5) & 0x3f;
    const blue = value & 0x1f;
    const r8 = (red << 3) | (red >> 2);
    const g8 = (green << 2) | (green >> 4);
    const b8 = (blue << 3) | (blue >> 2);
    lut[value] = (0xff00_0000 | (b8 << 16) | (g8 << 8) | r8) >>> 0;
  }

  return lut;
}

/** The process-wide lookup table, built on first use. */
export function getRgb565Lut(): Uint32Array {
  if (rgbaLut === null) {
    rgbaLut = buildRgb565Lut();
  }
  return rgbaLut;
}

/**
 * Merge the applied regions into the rectangles the canvas write needs: the
 * union bounding box when it is not much larger than the covered area,
 * otherwise one rectangle per region.
 */
function mergeDirtyRects(rects: RgbaRect[]): RgbaRect[] {
  if (rects.length <= 1) {
    return rects;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let area = 0;

  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
    area += rect.width * rect.height;
  }

  const union = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  if (union.width * union.height <= 4 * area) {
    return [union];
  }

  return rects;
}

export class ScreenCanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly byteOrder: ByteOrder;
  private readonly lut: Uint32Array;

  private width = 0;
  private height = 0;
  private frameScratch: Uint8ClampedArray<ArrayBuffer> | null = null;
  private rgbaView: Uint32Array | null = null;
  private imageData: ImageData | null = null;
  private pending: RgbaRect[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.byteOrder = resolveByteOrder();
    this.lut = getRgb565Lut();
  }

  /**
   * Reset-frame geometry step: resize the canvas, clear it to opaque black,
   * and reallocate the scratch buffers. Called only for a validated reset
   * frame, before its regions are applied.
   */
  resize(width: number, height: number): void {
    if (width < 1 || height < 1) {
      return;
    }

    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    const scratch: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    this.frameScratch = scratch;
    // The scratch is allocated here and nowhere else, so the fast path's
    // 32-bit view is built here too: no per-frame view allocation.
    this.rgbaView = this.byteOrder === "little" ? new Uint32Array(scratch.buffer) : null;
    this.imageData = new ImageData(scratch, width, height);
    this.pending = [];

    if (this.context) {
      this.context.fillStyle = "#000000";
      this.context.fillRect(0, 0, width, height);
    }
  }

  /**
   * Apply one frame's validated region set. The frame's geometry must match
   * the size of {@link resize}; the stream rejects any other geometry before
   * calling in. The op streams were validated by the stream, so application is
   * a single walk per region with no intermediate representation.
   */
  applyFrame(frame: { width: number; height: number }, regions: RenderRegion[]): void {
    const scratch = this.frameScratch;
    if (!scratch || !this.imageData) {
      return;
    }
    if (frame.width !== this.width || frame.height !== this.height) {
      return;
    }

    const target = this.rgbaView ?? scratch;
    const stride = this.width;
    for (const entry of regions) {
      const region = entry.region;
      const verdict = walkOpStream(
        entry.ops,
        region,
        "sparse",
        target,
        stride,
        region.y * stride + region.x,
        this.lut,
      );
      if (!verdict.ok) {
        // Unreachable for a validated frame: the stream validates each region
        // with the same walker before it calls in. Fail loudly rather than
        // acking a frame whose cells were not written.
        throw new Error(`region op stream failed validation: ${verdict.reason}`);
      }
      this.pending.push({
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      });
    }
  }

  /** The dirty rectangles the next {@link flush} will write. */
  get dirtyRects(): RgbaRect[] {
    return mergeDirtyRects(this.pending);
  }

  /** Write the dirty rectangles to the canvas; one `putImageData` per rect. */
  flush(): void {
    const rects = mergeDirtyRects(this.pending);
    this.pending = [];

    if (!this.context || !this.imageData) {
      return;
    }

    for (const rect of rects) {
      this.context.putImageData(this.imageData, 0, 0, rect.x, rect.y, rect.width, rect.height);
    }
  }
}
