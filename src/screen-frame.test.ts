import { describe, expect, it } from "vitest";

import {
  MAX_SURFACE_CELLS,
  MAX_REGIONS_PER_CHUNK,
  CODEC_TESSELLIO,
  ScreenFrameAssembler,
  parseScreenFrameChunk,
  validateChunk,
  type UpdateChunk,
  type UpdateRegion,
} from "./screen-frame";

function region(overrides: Partial<UpdateRegion> = {}): UpdateRegion {
  return {
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ...overrides,
  };
}

function chunk(overrides: Partial<UpdateChunk> = {}): UpdateChunk {
  return {
    updateId: 2,
    baseUpdateId: 1,
    width: 8,
    height: 4,
    partIndex: 0,
    partCount: 1,
    updateBytes: 9,
    codec: CODEC_TESSELLIO,
    regions: [region()],
    ...overrides,
  };
}

function reasonOf(verdict: ReturnType<typeof validateChunk>): string | null {
  return verdict.ok ? null : verdict.reason;
}

describe("parseScreenFrameChunk", () => {
  it("parses the generated event shape", () => {
    const parsed = parseScreenFrameChunk({
      updateId: 12,
      baseUpdateId: 11,
      width: 64,
      height: 48,
      partIndex: 1,
      partCount: 2,
      updateBytes: 9,
      codec: 8,
      regions: [{ x: 3, y: 4, width: 2, height: 2, payload: new Uint8Array([9, 8, 7]) }],
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.updateId).toBe(12);
    expect(parsed?.partIndex).toBe(1);
    expect(parsed?.regions).toHaveLength(1);
    expect(parsed?.regions[0].payload).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("parses an idle delta with no regions and an omitted codec field as zero", () => {
    const parsed = parseScreenFrameChunk({
      updateId: 7,
      baseUpdateId: 6,
      width: 8,
      height: 4,
      partIndex: 0,
      partCount: 1,
      updateBytes: 0,
      regions: [],
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.regions).toHaveLength(0);
    // A proto3 default is omitted on the wire; the chunk then fails the codec
    // check instead of being decoded as a different format.
    expect(parsed?.codec).toBe(0);
    expect(reasonOf(validateChunk(parsed as UpdateChunk))).toBe("UNKNOWN_CODEC");
  });

  it("rejects a chunk with missing identity fields or non-integer geometry", () => {
    expect(parseScreenFrameChunk(null)).toBeNull();
    expect(parseScreenFrameChunk("screen.frame")).toBeNull();
    expect(
      parseScreenFrameChunk({ width: 8, height: 4, partIndex: 0, partCount: 1, updateBytes: 0 }),
    ).toBeNull();
    expect(
      parseScreenFrameChunk({
        updateId: 2,
        baseUpdateId: 1,
        width: 8.5,
        height: 4,
        partIndex: 0,
        partCount: 1,
        updateBytes: 0,
      }),
    ).toBeNull();
  });

  it("rejects the whole chunk when one region cannot be parsed", () => {
    const parsed = parseScreenFrameChunk({
      updateId: 2,
      baseUpdateId: 1,
      width: 8,
      height: 4,
      partIndex: 0,
      partCount: 1,
      updateBytes: 4,
      regions: [
        { x: 0, y: 0, width: 1, height: 1, payload: new Uint8Array([1]) },
        { x: 1, y: 0, width: 1, height: 1 },
      ],
    });

    expect(parsed).toBeNull();
  });

  it("rejects a region whose payload is not a byte view", () => {
    expect(
      parseScreenFrameChunk({
        updateId: 2,
        baseUpdateId: 1,
        width: 8,
        height: 4,
        partIndex: 0,
        partCount: 1,
        updateBytes: 1,
        regions: [{ x: 0, y: 0, width: 1, height: 1, payload: "AQ==" }],
      }),
    ).toBeNull();
  });
});

describe("validateChunk", () => {
  it("accepts a well-formed chunk", () => {
    expect(validateChunk(chunk())).toEqual({ ok: true });
  });

  it("rejects any codec id other than tessellio", () => {
    expect(reasonOf(validateChunk(chunk({ codec: 0 })))).toBe("UNKNOWN_CODEC");
    expect(reasonOf(validateChunk(chunk({ codec: 1 })))).toBe("UNKNOWN_CODEC");
    expect(reasonOf(validateChunk(chunk({ codec: 3 })))).toBe("UNKNOWN_CODEC");
    expect(reasonOf(validateChunk(chunk({ codec: 9 })))).toBe("UNKNOWN_CODEC");
  });

  it("rejects broken frame identity", () => {
    expect(reasonOf(validateChunk(chunk({ updateId: 0 })))).toBe("CHUNK_GAP");
    expect(reasonOf(validateChunk(chunk({ baseUpdateId: 2 })))).toBe("CHUNK_GAP");
    expect(reasonOf(validateChunk(chunk({ baseUpdateId: 5 })))).toBe("CHUNK_GAP");
    expect(reasonOf(validateChunk(chunk({ baseUpdateId: 0 })))).toBeNull();
  });

  it("rejects broken chunk identity", () => {
    expect(reasonOf(validateChunk(chunk({ partIndex: -1 })))).toBe("CHUNK_GAP");
    expect(reasonOf(validateChunk(chunk({ partCount: 0 })))).toBe("CHUNK_GAP");
    expect(reasonOf(validateChunk(chunk({ partIndex: 2, partCount: 2 })))).toBe("CHUNK_GAP");
    expect(reasonOf(validateChunk(chunk({ partCount: 9 })))).toBe("CHUNK_GAP");
  });

  it("rejects impossible geometry", () => {
    expect(reasonOf(validateChunk(chunk({ width: 0 })))).toBe("GEOMETRY_MISMATCH");
    expect(reasonOf(validateChunk(chunk({ height: -4 })))).toBe("GEOMETRY_MISMATCH");
    expect(reasonOf(validateChunk(chunk({ width: 8193, height: 1 })))).toBe("GEOMETRY_MISMATCH");
    expect(
      reasonOf(
        validateChunk(
          chunk({
            width: MAX_SURFACE_CELLS / 16 + 16,
            height: 16,
            regions: [],
          }),
        ),
      ),
    ).toBe("GEOMETRY_MISMATCH");
  });

  it("rejects a declared frame size outside the caps", () => {
    expect(reasonOf(validateChunk(chunk({ updateBytes: -1 })))).toBe("INCOMPLETE_FRAME");
    expect(reasonOf(validateChunk(chunk({ updateBytes: 3_932_161 })))).toBe("INCOMPLETE_FRAME");
  });

  it("rejects more regions than a chunk may carry", () => {
    const regions = Array.from({ length: MAX_REGIONS_PER_CHUNK + 1 }, (_, index) =>
      region({ x: index % 8, y: Math.floor(index / 8), width: 1, height: 1, payload: new Uint8Array([1]) }),
    );
    expect(reasonOf(validateChunk(chunk({ regions, updateBytes: regions.length })))).toBe("DECODE_ERROR");
  });

  it("rejects a region outside the frame or without a payload", () => {
    expect(reasonOf(validateChunk(chunk({ regions: [region({ x: 7, width: 2 })] })))).toBe("DECODE_ERROR");
    expect(reasonOf(validateChunk(chunk({ regions: [region({ y: 3, height: 2 })] })))).toBe("DECODE_ERROR");
    expect(reasonOf(validateChunk(chunk({ regions: [region({ width: 0 })] })))).toBe("DECODE_ERROR");
    expect(reasonOf(validateChunk(chunk({ regions: [region({ payload: new Uint8Array(0) })] })))).toBe(
      "DECODE_ERROR",
    );
    expect(
      reasonOf(validateChunk(chunk({ regions: [region({ payload: new Uint8Array(262_145) })] }))),
    ).toBe("DECODE_ERROR");
  });

  it("rejects unordered or overlapping regions", () => {
    const first = region({ x: 0, y: 0, width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4]) });
    const second = region({ x: 2, y: 0, width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4]) });

    expect(reasonOf(validateChunk(chunk({ regions: [second, first], updateBytes: 8 })))).toBe("DECODE_ERROR");
    expect(
      reasonOf(validateChunk(chunk({ regions: [first, second], updateBytes: 8 }))),
    ).toBeNull();

    const overlapping = region({ x: 1, y: 0, width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4]) });
    expect(reasonOf(validateChunk(chunk({ regions: [first, overlapping], updateBytes: 8 })))).toBe(
      "DECODE_ERROR",
    );
  });

  it("applies the assembler's configured caps", () => {
    const limits = { maxFrameBytes: 8, maxRegions: 1 };
    expect(reasonOf(validateChunk(chunk({ updateBytes: 9 }), limits))).toBe("INCOMPLETE_FRAME");
    expect(reasonOf(validateChunk(chunk({ updateBytes: 8 }), limits))).toBeNull();
  });
});

describe("ScreenFrameAssembler", () => {
  it("completes a single-chunk frame", () => {
    const assembler = new ScreenFrameAssembler();
    const { frame, resync } = assembler.push(chunk());

    expect(resync).toBeNull();
    expect(frame).not.toBeNull();
    expect(frame?.updateId).toBe(2);
    expect(frame?.chunks).toBe(1);
    expect(frame?.regions).toHaveLength(1);
  });

  it("completes an idle delta frame with no regions", () => {
    const assembler = new ScreenFrameAssembler();
    const { frame, resync } = assembler.push(
      chunk({ updateId: 7, baseUpdateId: 6, updateBytes: 0, regions: [] }),
    );

    expect(resync).toBeNull();
    expect(frame?.updateId).toBe(7);
    expect(frame?.regions).toHaveLength(0);
    expect(frame?.updateBytes).toBe(0);
  });

  it("assembles a two-chunk frame and reports nothing in between", () => {
    const assembler = new ScreenFrameAssembler();
    const first = assembler.push(
      chunk({ updateId: 10, baseUpdateId: 9, partIndex: 0, partCount: 2, updateBytes: 18 }),
    );
    expect(first.frame).toBeNull();
    expect(first.resync).toBeNull();

    const second = assembler.push(
      chunk({
        updateId: 10,
        baseUpdateId: 9,
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
      }),
    );
    expect(second.resync).toBeNull();
    expect(second.frame?.chunks).toBe(2);
    expect(second.frame?.regions).toHaveLength(2);
  });

  it("refuses a frame whose first chunk was missed", () => {
    const assembler = new ScreenFrameAssembler();
    const { frame, resync } = assembler.push(chunk({ partIndex: 1, partCount: 2, updateBytes: 18 }));

    expect(frame).toBeNull();
    expect(resync).toBe("CHUNK_GAP");
  });

  it("refuses a non-contiguous chunk and drops the partial frame", () => {
    const assembler = new ScreenFrameAssembler();
    assembler.push(chunk({ partIndex: 0, partCount: 3, updateBytes: 27 }));

    const gap = assembler.push(chunk({ partIndex: 2, partCount: 3, updateBytes: 27 }));
    expect(gap.resync).toBe("CHUNK_GAP");

    // The partial frame is gone: chunk 1 now arrives without its first chunk.
    const stale = assembler.push(chunk({ partIndex: 1, partCount: 3, updateBytes: 27 }));
    expect(stale.resync).toBe("CHUNK_GAP");
  });

  it("rejects a update_bytes mismatch when the last chunk completes the frame", () => {
    const assembler = new ScreenFrameAssembler();
    const first = assembler.push(chunk({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    expect(first.resync).toBeNull();

    // Replicated update_bytes must agree between the chunks of one frame.
    const disagreeing = assembler.push(chunk({ partIndex: 1, partCount: 2, updateBytes: 17 }));
    expect(disagreeing.resync).toBe("CHUNK_GAP");

    // The sum of the chunk payloads must equal the declared frame size.
    assembler.push(chunk({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    const short = assembler.push(
      chunk({
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
        regions: [region({ x: 2, width: 1, payload: new Uint8Array([1, 2, 3]) })],
      }),
    );
    expect(short.resync).toBe("INCOMPLETE_FRAME");

    assembler.push(chunk({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    const overrun = assembler.push(
      chunk({
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
        regions: [region({ x: 2, width: 1, payload: new Uint8Array(12) })],
      }),
    );
    expect(overrun.resync).toBe("INCOMPLETE_FRAME");
  });

  it("drops a partial frame when another frame id arrives", () => {
    const assembler = new ScreenFrameAssembler();
    assembler.push(chunk({ updateId: 10, partIndex: 0, partCount: 2, updateBytes: 18 }));

    const next = assembler.push(chunk({ updateId: 11, baseUpdateId: 10, updateBytes: 9 }));
    expect(next.resync).toBeNull();
    expect(next.frame?.updateId).toBe(11);
  });

  it("discards a partial reset frame when a delta arrives and requires a fresh start", () => {
    const assembler = new ScreenFrameAssembler();
    assembler.push(chunk({ updateId: 20, baseUpdateId: 0, partIndex: 0, partCount: 2, updateBytes: 18 }));

    const delta = assembler.push(chunk({ updateId: 21, baseUpdateId: 20, partIndex: 1, partCount: 2 }));
    expect(delta.resync).toBe("CHUNK_GAP");

    const restart = assembler.push(chunk({ updateId: 21, baseUpdateId: 20, partIndex: 0, partCount: 2 }));
    expect(restart.resync).toBeNull();
    expect(restart.frame).toBeNull();
  });

  it("enforces the configured region cap across chunks", () => {
    const assembler = new ScreenFrameAssembler({ maxRegions: 1 });
    const first = assembler.push(
      chunk({ partIndex: 0, partCount: 2, updateBytes: 18, regions: [region()] }),
    );
    expect(first.resync).toBeNull();

    const second = assembler.push(
      chunk({
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
        regions: [region({ x: 2, width: 1 })],
      }),
    );
    expect(second.resync).toBe("INCOMPLETE_FRAME");
  });

  it("validates every chunk before it can join an assembly", () => {
    const assembler = new ScreenFrameAssembler();
    const bad = assembler.push(chunk({ codec: 3 }));
    expect(bad.resync).toBe("UNKNOWN_CODEC");
    expect(bad.frame).toBeNull();

    // The rejected chunk left no partial state behind.
    const good = assembler.push(chunk());
    expect(good.frame?.updateId).toBe(2);
  });

  it("reset drops the partial assembly", () => {
    const assembler = new ScreenFrameAssembler();
    assembler.push(chunk({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    assembler.reset();

    const continuation = assembler.push(chunk({ partIndex: 1, partCount: 2, updateBytes: 18 }));
    expect(continuation.resync).toBe("CHUNK_GAP");
  });
});
