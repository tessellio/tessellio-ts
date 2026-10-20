import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SurfaceCanvasRenderer } from "./surface";
import {
  SurfaceStream,
  type SurfaceApplyReport,
  type SurfaceFailureReport,
} from "./surface-stream";
import { CODEC_TESSELLIO, type UpdatePart, type UpdateRegion } from "./update-parts";

/**
 * jsdom has no `ImageData` and no 2D context; the double below records
 * `putImageData` into an RGBA buffer so the stream tests can read the canvas
 * back. The production renderer is used unmodified.
 */
class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

type TestCanvas = {
  canvas: HTMLCanvasElement;
  cells: Uint8ClampedArray;
  draws: Array<{ x: number; y: number; width: number; height: number }>;
  readCell: (x: number, y: number) => number[];
};

function createTestCanvas(width: number, height: number): TestCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  // The double keeps a generous buffer so a later canvas.resize stays readable.
  const cells = new Uint8ClampedArray(256 * 256 * 4);
  const draws: TestCanvas["draws"] = [];

  const context = {
    fillStyle: "#000000",
    fillRect: (x: number, y: number, w: number, h: number): void => {
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

  Object.defineProperty(canvas, "getContext", { value: () => context, configurable: true });

  return {
    canvas,
    cells,
    draws,
    readCell: (x: number, y: number) =>
      Array.from(cells.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)),
  };
}

/**
 * One stored-DEFLATE block (`BFINAL=1`, `BTYPE=00`): every byte is
 * hand-derivable, so the op streams the tests build are readable.
 */
function storedDeflate(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(raw.length + 5);
  payload[0] = 0x01;
  payload[1] = raw.length & 0xff;
  payload[2] = (raw.length >> 8) & 0xff;
  const inverted = ~raw.length & 0xffff;
  payload[3] = inverted & 0xff;
  payload[4] = (inverted >> 8) & 0xff;
  payload.set(raw, 5);
  return payload;
}

type Patch = { row: number; x: number; values: number[] };

/**
 * A one-row region's ops are region-local: the patch's absolute row and
 * column live in the region box the update declares, not in the op stream.
 */
function patchOps(patch: Patch): Uint8Array<ArrayBuffer> {
  const ops: number[] = [0x01, 0x00, 0x00, 0x02, 0x00, 0x00];
  ops.push(patch.values.length & 0xff, (patch.values.length >> 8) & 0xff);
  for (const value of patch.values) {
    ops.push(value & 0xff, (value >> 8) & 0xff);
  }
  ops.push(0x00);
  return storedDeflate(Uint8Array.from(ops));
}

/** A full-coverage region: one `FILL` per row. */
function fullCoverageOps(width: number, height: number, valueFor: (row: number) => number): Uint8Array<ArrayBuffer> {
  const ops: number[] = [];
  for (let row = 0; row < height; row += 1) {
    const value = valueFor(row);
    ops.push(0x01, row & 0xff, (row >> 8) & 0xff);
    ops.push(0x03, 0x00, 0x00, width & 0xff, (width >> 8) & 0xff, value & 0xff, (value >> 8) & 0xff);
  }
  ops.push(0x00);
  return storedDeflate(Uint8Array.from(ops));
}

type UpdateOptions = {
  updateId: number;
  baseUpdateId?: number;
  width: number;
  height: number;
  regions: UpdateRegion[];
  partIndex?: number;
  partCount?: number;
  updateBytes?: number;
  codec?: number;
  anchor?: boolean;
};

function updatePart(options: UpdateOptions): UpdatePart {
  const updateBytes =
    options.updateBytes ??
    options.regions.reduce((total, region) => total + region.payload.byteLength, 0);
  return {
    updateId: options.updateId,
    baseUpdateId: options.baseUpdateId ?? 0,
    width: options.width,
    height: options.height,
    partIndex: options.partIndex ?? 0,
    partCount: options.partCount ?? 1,
    updateBytes,
    codec: options.codec ?? CODEC_TESSELLIO,
    anchor: options.anchor,
    regions: options.regions,
  };
}

function resetUpdate(
  updateId: number,
  width: number,
  height: number,
  valueFor: (row: number) => number,
): UpdatePart {
  return updatePart({
    updateId,
    baseUpdateId: 0,
    width,
    height,
    regions: [{ x: 0, y: 0, width, height, payload: fullCoverageOps(width, height, valueFor) }],
  });
}

function deltaUpdate(
  updateId: number,
  baseUpdateId: number,
  width: number,
  height: number,
  patches: Patch[],
): UpdatePart {
  return updatePart({
    updateId,
    baseUpdateId,
    width,
    height,
    regions: patches.map((patch) => ({
      x: patch.x,
      y: patch.row,
      width: patch.values.length,
      height: 1,
      payload: patchOps(patch),
    })),
  });
}

type Harness = {
  stream: SurfaceStream;
  canvas: TestCanvas;
  applied: SurfaceApplyReport[];
  failures: SurfaceFailureReport[];
};

function createStream(options?: { now?: () => number }): Harness {
  const canvas = createTestCanvas(1, 1);
  const renderer = new SurfaceCanvasRenderer(canvas.canvas);
  const applied: SurfaceApplyReport[] = [];
  const failures: SurfaceFailureReport[] = [];
  const stream = new SurfaceStream({
    renderer,
    now: options?.now,
    onApplied: (report) => applied.push(report),
    onFailure: (failure) => failures.push(failure),
  });
  return { stream, canvas, applied, failures };
}

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function writePatch(reference: Uint16Array, width: number, patch: Patch): void {
  patch.values.forEach((value, index) => {
    reference[patch.row * width + patch.x + index] = value;
  });
}

beforeEach(() => {
  vi.stubGlobal("ImageData", TestImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SurfaceStream applies and paints", () => {
  it("applies a whole update and paints it", async () => {
    const harness = createStream();

    harness.stream.applyPart(resetUpdate(1, 4, 2, (row) => (row === 0 ? 0xf800 : 0x07e0)), {});

    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    expect(harness.applied[0].updateId).toBe(1);
    expect(harness.canvas.draws).toHaveLength(1);
    expect(harness.canvas.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(harness.canvas.readCell(0, 1)).toEqual([0, 255, 0, 255]);
    expect(harness.stream.appliedUpdateId).toBe(1);
    expect(harness.stream.stats.updatesApplied).toBe(1);
  });

  it("applies a delta onto the update it names", async () => {
    const harness = createStream();
    harness.stream.applyPart(resetUpdate(1, 4, 2, () => 0x0000), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    harness.stream.applyPart(deltaUpdate(2, 1, 4, 2, [{ row: 1, x: 1, values: [0xffff, 0xf81f] }]), {});

    await vi.waitFor(() => expect(harness.applied).toHaveLength(2));

    expect(harness.applied[1].updateId).toBe(2);
    expect(harness.canvas.readCell(1, 1)).toEqual([255, 255, 255, 255]);
    expect(harness.canvas.readCell(2, 1)).toEqual([255, 0, 255, 255]);
    expect(harness.canvas.readCell(0, 1)).toEqual([0, 0, 0, 255]);
    expect(harness.stream.appliedUpdateId).toBe(2);
  });

  it("assembles the parts of one update and reports the part that completed it", async () => {
    const harness = createStream();
    const top = fullCoverageOps(4, 1, () => 0xf800);
    const bottom = fullCoverageOps(4, 1, () => 0x07e0);
    // Both parts declare the byte count of the whole update.
    const updateBytes = top.byteLength + bottom.byteLength;
    const first = updatePart({
      updateId: 7,
      baseUpdateId: 0,
      width: 4,
      height: 2,
      partIndex: 0,
      partCount: 2,
      updateBytes,
      regions: [{ x: 0, y: 0, width: 4, height: 1, payload: top }],
    });
    const second = updatePart({
      updateId: 7,
      baseUpdateId: 0,
      width: 4,
      height: 2,
      partIndex: 1,
      partCount: 2,
      updateBytes,
      regions: [{ x: 0, y: 1, width: 4, height: 1, payload: bottom }],
    });

    harness.stream.applyPart(first, {});
    await settle(2);
    // The update is still assembling: nothing is painted and nothing reported.
    expect(harness.applied).toHaveLength(0);
    expect(harness.canvas.draws).toHaveLength(0);

    harness.stream.applyPart(second, {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    expect(harness.applied[0]).toMatchObject({ updateId: 7, partIndex: 1 });
    expect(harness.canvas.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(harness.canvas.readCell(0, 1)).toEqual([0, 255, 0, 255]);
  });

  it("applies an update that carries no region without writing to the canvas", async () => {
    const harness = createStream();
    harness.stream.applyPart(resetUpdate(1, 4, 2, () => 0x0000), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));
    const drawsAfterReset = harness.canvas.draws.length;

    harness.stream.applyPart(updatePart({ updateId: 2, baseUpdateId: 1, width: 4, height: 2, regions: [] }), {});

    await vi.waitFor(() => expect(harness.applied).toHaveLength(2));

    expect(harness.applied[1].updateId).toBe(2);
    expect(harness.canvas.draws).toHaveLength(drawsAfterReset);
    expect(harness.canvas.readCell(1, 1)).toEqual([0, 0, 0, 255]);
  });

  it("reports the state of the surface it applied", async () => {
    const harness = createStream();

    harness.stream.applyPart(resetUpdate(4, 8, 5, () => 0x0000), {});

    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    expect(harness.applied[0]).toMatchObject({
      updateId: 4,
      partIndex: 0,
      appliedCellCount: 40,
      staleCells: 0,
      converged: true,
    });
    expect(typeof harness.applied[0].renderLatencyMs).toBe("number");
    expect(harness.stream.appliedCellCount).toBe(40);
    expect(harness.stream.staleCellCount).toBe(0);
    expect(harness.stream.isConverged).toBe(true);
  });

  it("measures the render latency from the update's first part", async () => {
    let clock = 0;
    const harness = createStream({ now: () => clock });

    harness.stream.applyPart(resetUpdate(1, 4, 2, () => 0x0000), {});
    clock = 25;

    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    expect(harness.applied[0].renderLatencyMs).toBe(25);
    expect(harness.applied[0].hasRenderLatencyMs).toBe(true);
  });

  it("ignores a part of an update it already applied", async () => {
    const harness = createStream();
    const part = resetUpdate(1, 4, 2, () => 0xf800);
    harness.stream.applyPart(part, {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    harness.stream.applyPart(part, {});
    await settle(2);

    expect(harness.applied).toHaveLength(1);
    expect(harness.failures).toHaveLength(0);
    expect(harness.stream.stats.duplicatePartsIgnored).toBe(1);
  });
});

describe("SurfaceStream refusals", () => {
  it("refuses a delta whose base is not held and keeps the canvas", async () => {
    const harness = createStream();
    harness.stream.applyPart(resetUpdate(1, 4, 2, () => 0xf800), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    harness.stream.applyPart(deltaUpdate(5, 2, 4, 2, [{ row: 0, x: 0, values: [0x0000] }]), {});

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0]).toEqual({ reason: "INCOMPLETE_UPDATE", heldUpdateId: 1 });
    expect(harness.stream.appliedUpdateId).toBe(1);
    expect(harness.canvas.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(harness.applied).toHaveLength(1);
  });

  it("refuses a delta with a different geometry and keeps the canvas size", async () => {
    const harness = createStream();
    harness.stream.applyPart(resetUpdate(1, 4, 2, () => 0x07e0), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    harness.stream.applyPart(deltaUpdate(2, 1, 8, 8, [{ row: 0, x: 0, values: [0x0000] }]), {});

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0]).toEqual({ reason: "INCOMPLETE_UPDATE", heldUpdateId: 1 });
    expect(harness.canvas.canvas.width).toBe(4);
    expect(harness.canvas.canvas.height).toBe(2);
    expect(harness.stream.appliedUpdateId).toBe(1);
  });

  it("refuses a region that does not decode, without writing a cell", async () => {
    const harness = createStream();
    harness.stream.applyPart(resetUpdate(1, 4, 2, () => 0x001f), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));
    const drawsBefore = harness.canvas.draws.length;

    const malformed = deltaUpdate(2, 1, 4, 2, [{ row: 0, x: 0, values: [0xffff] }]);
    const region = malformed.regions[0];
    // Same declared size, garbage bytes: the region decodes to a decode error.
    region.payload = new Uint8Array(region.payload.byteLength).fill(0xff);
    harness.stream.applyPart(malformed, {});

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0]).toEqual({ reason: "INCOMPLETE_UPDATE", heldUpdateId: 1 });
    expect(harness.stream.appliedUpdateId).toBe(1);
    expect(harness.canvas.draws).toHaveLength(drawsBefore);
    expect(harness.canvas.readCell(0, 0)).toEqual([0, 0, 255, 255]);
    expect(harness.applied).toHaveLength(1);
  });

  it("refuses an absolute update whose coverage is incomplete", async () => {
    const gapOps = storedDeflate(new Uint8Array([0x01, 0x00, 0x00, 0x03, 0x01, 0x00, 0x02, 0x00, 0xff, 0xff, 0x00]));
    const harness = createStream();

    harness.stream.applyPart(
      updatePart({
        updateId: 1,
        baseUpdateId: 0,
        width: 4,
        height: 1,
        regions: [{ x: 0, y: 0, width: 4, height: 1, payload: gapOps }],
      }),
      {},
    );

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0]).toEqual({ reason: "INCOMPLETE_UPDATE", heldUpdateId: 0 });
    expect(harness.stream.appliedUpdateId).toBe(0);
    expect(harness.applied).toHaveLength(0);
  });

  it("reports a missing part as a part gap", async () => {
    const harness = createStream();

    // The second part of a two-part update: the first one never arrived.
    harness.stream.applyPart(
      updatePart({
        updateId: 9,
        baseUpdateId: 0,
        width: 4,
        height: 1,
        regions: [],
        partIndex: 1,
        partCount: 2,
      }),
      {},
    );

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0]).toEqual({ reason: "PART_GAP", heldUpdateId: 0 });
    expect(harness.stream.appliedUpdateId).toBe(0);
    expect(harness.applied).toHaveLength(0);
  });

  it("refuses a part of another codec", async () => {
    const harness = createStream();

    harness.stream.applyPart(
      updatePart({ updateId: 1, baseUpdateId: 0, width: 2, height: 2, regions: [], codec: 3 }),
      {},
    );

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0]).toEqual({ reason: "INCOMPLETE_UPDATE", heldUpdateId: 0 });
    expect(harness.stream.appliedUpdateId).toBe(0);
  });

  it("drops a stale delta without a report", async () => {
    const harness = createStream();
    harness.stream.applyPart(resetUpdate(5, 2, 2, () => 0x0000), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));

    harness.stream.applyPart(deltaUpdate(4, 3, 2, 2, [{ row: 0, x: 0, values: [0xffff] }]), {});
    await settle(2);

    expect(harness.failures).toHaveLength(0);
    expect(harness.applied).toHaveLength(1);
    expect(harness.stream.appliedUpdateId).toBe(5);
    expect(harness.stream.stats.updatesDropped).toBe(1);
    expect(harness.canvas.readCell(0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("drops the backlog when the stream cannot keep up", async () => {
    const harness = createStream();

    harness.stream.applyPart(resetUpdate(1, 2, 2, () => 0x0000), {});
    harness.stream.applyPart(resetUpdate(2, 2, 2, () => 0x1111), {});
    harness.stream.applyPart(resetUpdate(3, 2, 2, () => 0x2222), {});
    harness.stream.applyPart(resetUpdate(4, 2, 2, () => 0x3333), {});

    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));

    expect(harness.failures[0].reason).toBe("INCOMPLETE_UPDATE");
    expect(harness.stream.stats.updatesDropped).toBeGreaterThanOrEqual(1);
  });
});

describe("the canvas equals the sender's reference for the applied update", () => {
  it("stays exact through a lost update and a healing absolute update", async () => {
    const width = 4;
    const height = 3;
    const harness = createStream();
    const reference = new Uint16Array(width * height);

    const expectCanvas = (): void => {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const value = reference[y * width + x];
          const red = (value >> 11) & 0x1f;
          const green = (value >> 5) & 0x3f;
          const blue = value & 0x1f;
          expect(harness.canvas.readCell(x, y)).toEqual([
            (red << 3) | (red >> 2),
            (green << 2) | (green >> 4),
            (blue << 3) | (blue >> 2),
            255,
          ]);
        }
      }
    };

    // Update 1: absolute, all black.
    harness.stream.applyPart(resetUpdate(1, width, height, () => 0x0000), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(1));
    expectCanvas();

    // Update 2: a delta painting a row.
    const patch2 = { row: 1, x: 0, values: [0xf800, 0x07e0, 0x001f, 0xffff] };
    harness.stream.applyPart(deltaUpdate(2, 1, width, height, [patch2]), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(2));
    writePatch(reference, width, patch2);
    expectCanvas();

    // Update 3 is lost on the wire entirely.
    // Update 4 bases on the lost update: the stream refuses it.
    harness.stream.applyPart(
      deltaUpdate(4, 3, width, height, [{ row: 2, x: 0, values: [0x8410, 0x8410, 0x8410, 0x8410] }]),
      {},
    );
    await vi.waitFor(() => expect(harness.failures).toHaveLength(1));
    expect(harness.failures[0]).toEqual({ reason: "INCOMPLETE_UPDATE", heldUpdateId: 2 });
    expectCanvas();

    // The sender heals with an absolute update: the stream re-anchors exactly.
    const resetValues = [0x0000, 0xffff, 0x8410];
    harness.stream.applyPart(resetUpdate(5, width, height, (row) => resetValues[row] ?? 0x0000), {});
    await vi.waitFor(() => expect(harness.applied).toHaveLength(3));
    for (let row = 0; row < height; row += 1) {
      const value = resetValues[row] ?? 0x0000;
      for (let x = 0; x < width; x += 1) {
        reference[row * width + x] = value;
      }
    }
    expectCanvas();
    expect(harness.stream.appliedUpdateId).toBe(5);
    expect(harness.stream.stats.updatesApplied).toBe(3);
  });
});
