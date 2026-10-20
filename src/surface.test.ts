import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SurfaceCanvasRenderer,
  buildRgb565Lut,
  detectByteOrder,
  setRgb565ByteOrderForTest,
} from "./surface";

/**
 * jsdom has no `ImageData` and no 2D context, so the test supplies a minimal
 * `ImageData` holder and a context that records `putImageData` into an RGBA
 * buffer. Both are test doubles of DOM types jsdom does not implement; the
 * renderer itself is exercised unmodified.
 */
class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.replaceAll(" ", "");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

type TestCanvas = {
  canvas: HTMLCanvasElement;
  cells: Uint8ClampedArray;
  draws: Array<{ x: number; y: number; width: number; height: number }>;
  fills: Array<{ x: number; y: number; width: number; height: number; color: string }>;
  readCell: (x: number, y: number) => number[];
};

function createTestCanvas(width: number, height: number): TestCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  // The double keeps a generous buffer so a later canvas.resize stays readable.
  const cells = new Uint8ClampedArray(256 * 256 * 4);
  const draws: TestCanvas["draws"] = [];
  const fills: TestCanvas["fills"] = [];
  let fillStyle = "#000000";

  const context = {
    get fillStyle(): string {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    fillRect: (x: number, y: number, w: number, h: number): void => {
      fills.push({ x, y, width: w, height: h, color: fillStyle });
      for (let row = y; row < y + h; row += 1) {
        for (let column = x; column < x + w; column += 1) {
          const offset = (row * canvas.width + column) * 4;
          cells[offset] = 0;
          cells[offset + 1] = 0;
          cells[offset + 2] = 0;
          cells[offset + 3] = 255;
        }
      }
    },
    putImageData: (
      image: { data: Uint8ClampedArray; width: number },
      dx: number,
      dy: number,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ): void => {
      draws.push({ x: sx, y: sy, width: sw, height: sh });
      for (let row = 0; row < sh; row += 1) {
        for (let column = 0; column < sw; column += 1) {
          const source = ((sy + row) * image.width + sx + column) * 4;
          const target = ((dy + sy + row) * canvas.width + dx + sx + column) * 4;
          cells[target] = image.data[source];
          cells[target + 1] = image.data[source + 1];
          cells[target + 2] = image.data[source + 2];
          cells[target + 3] = image.data[source + 3];
        }
      }
    },
  };

  Object.defineProperty(canvas, "getContext", {
    value: () => context,
    configurable: true,
  });

  return {
    canvas,
    cells,
    draws,
    fills,
    readCell: (x: number, y: number) =>
      Array.from(cells.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)),
  };
}

beforeEach(() => {
  vi.stubGlobal("ImageData", TestImageData);
  setRgb565ByteOrderForTest(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setRgb565ByteOrderForTest(null);
});

describe("the 16-bit cell format lookup table", () => {
  it("expands the wire colors with bit replication", () => {
    const lut = buildRgb565Lut();
    const rgbaOf = (value: number): number[] =>
      Array.from(new Uint8Array(new Uint32Array([lut[value]]).buffer));

    expect(rgbaOf(0x0000)).toEqual([0, 0, 0, 255]);
    expect(rgbaOf(0xf800)).toEqual([255, 0, 0, 255]);
    expect(rgbaOf(0x07e0)).toEqual([0, 255, 0, 255]);
    expect(rgbaOf(0x001f)).toEqual([0, 0, 255, 255]);
    expect(rgbaOf(0x8410)).toEqual([132, 130, 132, 255]);
    expect(rgbaOf(0xffff)).toEqual([255, 255, 255, 255]);
  });

  it("detects a byte order the table agrees with", () => {
    const order = detectByteOrder();
    const lut = buildRgb565Lut();
    const bytes = Array.from(new Uint8Array(new Uint32Array([lut[0xf800]]).buffer));

    // The fast path packs [R, G, B, A] for a little-endian host; on a big
    // -endian host the fallback writer is used instead and this ordering is
    // irrelevant, but the probe must still be well defined.
    expect(order).toBe("little");
    expect(bytes).toEqual([255, 0, 0, 255]);
  });

  it("documents the byte order the table packs for", () => {
    const lut = buildRgb565Lut();
    const bytes = Array.from(new Uint8Array(new Uint32Array([lut[0x8410]]).buffer));
    expect(bytes).toEqual([132, 130, 132, 255]);
  });
});

describe("SurfaceCanvasRenderer", () => {
  it("resizes, clears to opaque black, and reallocates its buffers", () => {
    const harness = createTestCanvas(2, 2);
    const renderer = new SurfaceCanvasRenderer(harness.canvas);

    renderer.resize(4, 3);

    expect(harness.canvas.width).toBe(4);
    expect(harness.canvas.height).toBe(3);
    expect(harness.fills).toEqual([{ x: 0, y: 0, width: 4, height: 3, color: "#000000" }]);
    expect(harness.readCell(3, 2)).toEqual([0, 0, 0, 255]);
  });

  it("applies FILL and SPAN regions and writes them on flush", () => {
    const harness = createTestCanvas(4, 2);
    const renderer = new SurfaceCanvasRenderer(harness.canvas);
    renderer.resize(4, 2);

    renderer.applyUpdate(
      { width: 4, height: 2 },
      [
        {
          region: { x: 0, y: 0, width: 4, height: 1 },
          ops: hexToBytes("01 00 00 03 00 00 02 00 00 F8 " + "02 02 00 02 00 E0 07 E0 FF " + "00"),
        },
      ],
    );

    expect(renderer.dirtyRects).toEqual([{ x: 0, y: 0, width: 4, height: 1 }]);
    const drawsBeforeFlush = harness.draws.length;
    expect(drawsBeforeFlush).toBe(0);

    renderer.flush();

    expect(harness.draws).toEqual([{ x: 0, y: 0, width: 4, height: 1 }]);
    expect(harness.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(harness.readCell(1, 0)).toEqual([255, 0, 0, 255]);
    expect(harness.readCell(2, 0)).toEqual([0, 255, 0, 255]);
    expect(harness.readCell(3, 0)).toEqual([255, 255, 0, 255]);
    // The untouched row stays as the resize cleared it.
    expect(harness.readCell(0, 1)).toEqual([0, 0, 0, 255]);
    expect(renderer.dirtyRects).toEqual([]);
  });

  it("produces identical bytes through the big-endian fallback path", () => {
    // FILL and SPAN in one region, so the fallback's run writer is exercised.
    const ops = hexToBytes("01 00 00 03 00 00 02 00 00 F8 " + "02 02 00 02 00 E0 07 E0 FF " + "00");
    const fast = createTestCanvas(4, 1);
    const fastRenderer = new SurfaceCanvasRenderer(fast.canvas);
    fastRenderer.resize(4, 1);
    fastRenderer.applyUpdate({ width: 4, height: 1 }, [
      { region: { x: 0, y: 0, width: 4, height: 1 }, ops },
    ]);
    fastRenderer.flush();

    setRgb565ByteOrderForTest("big");
    const slow = createTestCanvas(4, 1);
    const slowRenderer = new SurfaceCanvasRenderer(slow.canvas);
    slowRenderer.resize(4, 1);
    slowRenderer.applyUpdate({ width: 4, height: 1 }, [
      { region: { x: 0, y: 0, width: 4, height: 1 }, ops },
    ]);
    slowRenderer.flush();

    expect(Array.from(slow.cells.subarray(0, 16))).toEqual(Array.from(fast.cells.subarray(0, 16)));
    expect(slow.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(slow.readCell(1, 0)).toEqual([255, 0, 0, 255]);
    expect(slow.readCell(2, 0)).toEqual([0, 255, 0, 255]);
    expect(slow.readCell(3, 0)).toEqual([255, 255, 0, 255]);
  });

  it("merges nearby regions into one putImageData and keeps distant ones apart", () => {
    const nearby = createTestCanvas(8, 2);
    const nearbyRenderer = new SurfaceCanvasRenderer(nearby.canvas);
    nearbyRenderer.resize(8, 2);
    const fillOps = hexToBytes("01 00 00 03 00 00 01 00 00 F8 00");
    nearbyRenderer.applyUpdate(
      { width: 8, height: 2 },
      [
        { region: { x: 0, y: 0, width: 1, height: 1 }, ops: fillOps },
        { region: { x: 1, y: 0, width: 1, height: 1 }, ops: fillOps },
      ],
    );
    nearbyRenderer.flush();

    expect(nearby.draws).toEqual([{ x: 0, y: 0, width: 2, height: 1 }]);

    const far = createTestCanvas(16, 16);
    const farRenderer = new SurfaceCanvasRenderer(far.canvas);
    farRenderer.resize(16, 16);
    farRenderer.applyUpdate(
      { width: 16, height: 16 },
      [
        { region: { x: 0, y: 0, width: 1, height: 1 }, ops: fillOps },
        { region: { x: 15, y: 15, width: 1, height: 1 }, ops: fillOps },
      ],
    );
    farRenderer.flush();

    expect(far.draws).toEqual([
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 15, y: 15, width: 1, height: 1 },
    ]);
    expect(far.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(far.readCell(15, 15)).toEqual([255, 0, 0, 255]);
    expect(far.readCell(8, 8)).toEqual([0, 0, 0, 255]);
  });

  it("ignores a update whose geometry does not match the last resize", () => {
    const harness = createTestCanvas(4, 2);
    const renderer = new SurfaceCanvasRenderer(harness.canvas);
    renderer.resize(4, 2);

    renderer.applyUpdate(
      { width: 2, height: 2 },
      [
        {
          region: { x: 0, y: 0, width: 1, height: 1 },
          ops: hexToBytes("01 00 00 03 00 00 01 00 00 F8 00"),
        },
      ],
    );

    expect(renderer.dirtyRects).toEqual([]);
    renderer.flush();
    expect(harness.draws).toEqual([]);
    expect(harness.readCell(0, 0)).toEqual([0, 0, 0, 255]);
  });
});
