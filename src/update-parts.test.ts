import { describe, expect, it } from "vitest";

import {
  MAX_SURFACE_CELLS,
  MAX_REGIONS_PER_PART,
  CODEC_TESSELLIO,
  UpdateAssembler,
  parseUpdatePart,
  validatePart,
  type UpdatePart,
  type UpdateRegion,
} from "./update-parts";

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

function part(overrides: Partial<UpdatePart> = {}): UpdatePart {
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

function reasonOf(verdict: ReturnType<typeof validatePart>): string | null {
  return verdict.ok ? null : verdict.reason;
}

describe("parseUpdatePart", () => {
  it("parses the generated event shape", () => {
    const parsed = parseUpdatePart({
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
    const parsed = parseUpdatePart({
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
    // A proto3 default is omitted on the wire; the part then fails the codec
    // check instead of being decoded as a different format.
    expect(parsed?.codec).toBe(0);
    expect(reasonOf(validatePart(parsed as UpdatePart))).toBe("UNKNOWN_CODEC");
  });

  it("rejects a part with missing identity fields or non-integer geometry", () => {
    expect(parseUpdatePart(null)).toBeNull();
    expect(parseUpdatePart("screen.update")).toBeNull();
    expect(
      parseUpdatePart({ width: 8, height: 4, partIndex: 0, partCount: 1, updateBytes: 0 }),
    ).toBeNull();
    expect(
      parseUpdatePart({
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

  it("rejects the whole part when one region cannot be parsed", () => {
    const parsed = parseUpdatePart({
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
      parseUpdatePart({
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

describe("validatePart", () => {
  it("accepts a well-formed part", () => {
    expect(validatePart(part())).toEqual({ ok: true });
  });

  it("rejects any codec id other than tessellio", () => {
    expect(reasonOf(validatePart(part({ codec: 0 })))).toBe("UNKNOWN_CODEC");
    expect(reasonOf(validatePart(part({ codec: 1 })))).toBe("UNKNOWN_CODEC");
    expect(reasonOf(validatePart(part({ codec: 3 })))).toBe("UNKNOWN_CODEC");
    expect(reasonOf(validatePart(part({ codec: 9 })))).toBe("UNKNOWN_CODEC");
  });

  it("rejects broken update identity", () => {
    expect(reasonOf(validatePart(part({ updateId: 0 })))).toBe("PART_GAP");
    expect(reasonOf(validatePart(part({ baseUpdateId: 2 })))).toBe("PART_GAP");
    expect(reasonOf(validatePart(part({ baseUpdateId: 5 })))).toBe("PART_GAP");
    expect(reasonOf(validatePart(part({ baseUpdateId: 0 })))).toBeNull();
  });

  it("rejects broken part identity", () => {
    expect(reasonOf(validatePart(part({ partIndex: -1 })))).toBe("PART_GAP");
    expect(reasonOf(validatePart(part({ partCount: 0 })))).toBe("PART_GAP");
    expect(reasonOf(validatePart(part({ partIndex: 2, partCount: 2 })))).toBe("PART_GAP");
    expect(reasonOf(validatePart(part({ partCount: 9 })))).toBe("PART_GAP");
  });

  it("rejects impossible geometry", () => {
    expect(reasonOf(validatePart(part({ width: 0 })))).toBe("GEOMETRY_MISMATCH");
    expect(reasonOf(validatePart(part({ height: -4 })))).toBe("GEOMETRY_MISMATCH");
    expect(reasonOf(validatePart(part({ width: 8193, height: 1 })))).toBe("GEOMETRY_MISMATCH");
    expect(
      reasonOf(
        validatePart(
          part({
            width: MAX_SURFACE_CELLS / 16 + 16,
            height: 16,
            regions: [],
          }),
        ),
      ),
    ).toBe("GEOMETRY_MISMATCH");
  });

  it("rejects a declared update size outside the caps", () => {
    expect(reasonOf(validatePart(part({ updateBytes: -1 })))).toBe("INCOMPLETE_UPDATE");
    expect(reasonOf(validatePart(part({ updateBytes: 3_932_161 })))).toBe("INCOMPLETE_UPDATE");
  });

  it("rejects more regions than a part may carry", () => {
    const regions = Array.from({ length: MAX_REGIONS_PER_PART + 1 }, (_, index) =>
      region({ x: index % 8, y: Math.floor(index / 8), width: 1, height: 1, payload: new Uint8Array([1]) }),
    );
    expect(reasonOf(validatePart(part({ regions, updateBytes: regions.length })))).toBe("DECODE_ERROR");
  });

  it("rejects a region outside the update or without a payload", () => {
    expect(reasonOf(validatePart(part({ regions: [region({ x: 7, width: 2 })] })))).toBe("DECODE_ERROR");
    expect(reasonOf(validatePart(part({ regions: [region({ y: 3, height: 2 })] })))).toBe("DECODE_ERROR");
    expect(reasonOf(validatePart(part({ regions: [region({ width: 0 })] })))).toBe("DECODE_ERROR");
    expect(reasonOf(validatePart(part({ regions: [region({ payload: new Uint8Array(0) })] })))).toBe(
      "DECODE_ERROR",
    );
    expect(
      reasonOf(validatePart(part({ regions: [region({ payload: new Uint8Array(262_145) })] }))),
    ).toBe("DECODE_ERROR");
  });

  it("rejects unordered or overlapping regions", () => {
    const first = region({ x: 0, y: 0, width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4]) });
    const second = region({ x: 2, y: 0, width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4]) });

    expect(reasonOf(validatePart(part({ regions: [second, first], updateBytes: 8 })))).toBe("DECODE_ERROR");
    expect(
      reasonOf(validatePart(part({ regions: [first, second], updateBytes: 8 }))),
    ).toBeNull();

    const overlapping = region({ x: 1, y: 0, width: 2, height: 1, payload: new Uint8Array([1, 2, 3, 4]) });
    expect(reasonOf(validatePart(part({ regions: [first, overlapping], updateBytes: 8 })))).toBe(
      "DECODE_ERROR",
    );
  });

  it("applies the assembler's configured caps", () => {
    const limits = { maxUpdateBytes: 8, maxRegions: 1 };
    expect(reasonOf(validatePart(part({ updateBytes: 9 }), limits))).toBe("INCOMPLETE_UPDATE");
    expect(reasonOf(validatePart(part({ updateBytes: 8 }), limits))).toBeNull();
  });
});

describe("UpdateAssembler", () => {
  it("completes a single-part update", () => {
    const assembler = new UpdateAssembler();
    const { update, resync } = assembler.push(part());

    expect(resync).toBeNull();
    expect(update).not.toBeNull();
    expect(update?.updateId).toBe(2);
    expect(update?.parts).toBe(1);
    expect(update?.regions).toHaveLength(1);
  });

  it("completes an idle delta update with no regions", () => {
    const assembler = new UpdateAssembler();
    const { update, resync } = assembler.push(
      part({ updateId: 7, baseUpdateId: 6, updateBytes: 0, regions: [] }),
    );

    expect(resync).toBeNull();
    expect(update?.updateId).toBe(7);
    expect(update?.regions).toHaveLength(0);
    expect(update?.updateBytes).toBe(0);
  });

  it("assembles a two-part update and reports nothing in between", () => {
    const assembler = new UpdateAssembler();
    const first = assembler.push(
      part({ updateId: 10, baseUpdateId: 9, partIndex: 0, partCount: 2, updateBytes: 18 }),
    );
    expect(first.update).toBeNull();
    expect(first.resync).toBeNull();

    const second = assembler.push(
      part({
        updateId: 10,
        baseUpdateId: 9,
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
      }),
    );
    expect(second.resync).toBeNull();
    expect(second.update?.parts).toBe(2);
    expect(second.update?.regions).toHaveLength(2);
  });

  it("refuses a update whose first part was missed", () => {
    const assembler = new UpdateAssembler();
    const { update, resync } = assembler.push(part({ partIndex: 1, partCount: 2, updateBytes: 18 }));

    expect(update).toBeNull();
    expect(resync).toBe("PART_GAP");
  });

  it("refuses a non-contiguous part and drops the partial update", () => {
    const assembler = new UpdateAssembler();
    assembler.push(part({ partIndex: 0, partCount: 3, updateBytes: 27 }));

    const gap = assembler.push(part({ partIndex: 2, partCount: 3, updateBytes: 27 }));
    expect(gap.resync).toBe("PART_GAP");

    // The partial update is gone: part 1 now arrives without its first part.
    const stale = assembler.push(part({ partIndex: 1, partCount: 3, updateBytes: 27 }));
    expect(stale.resync).toBe("PART_GAP");
  });

  it("rejects a update_bytes mismatch when the last part completes the update", () => {
    const assembler = new UpdateAssembler();
    const first = assembler.push(part({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    expect(first.resync).toBeNull();

    // Replicated update_bytes must agree between the parts of one update.
    const disagreeing = assembler.push(part({ partIndex: 1, partCount: 2, updateBytes: 17 }));
    expect(disagreeing.resync).toBe("PART_GAP");

    // The sum of the part payloads must equal the declared update size.
    assembler.push(part({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    const short = assembler.push(
      part({
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
        regions: [region({ x: 2, width: 1, payload: new Uint8Array([1, 2, 3]) })],
      }),
    );
    expect(short.resync).toBe("INCOMPLETE_UPDATE");

    assembler.push(part({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    const overrun = assembler.push(
      part({
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
        regions: [region({ x: 2, width: 1, payload: new Uint8Array(12) })],
      }),
    );
    expect(overrun.resync).toBe("INCOMPLETE_UPDATE");
  });

  it("drops a partial update when another update id arrives", () => {
    const assembler = new UpdateAssembler();
    assembler.push(part({ updateId: 10, partIndex: 0, partCount: 2, updateBytes: 18 }));

    const next = assembler.push(part({ updateId: 11, baseUpdateId: 10, updateBytes: 9 }));
    expect(next.resync).toBeNull();
    expect(next.update?.updateId).toBe(11);
  });

  it("discards a partial reset update when a delta arrives and requires a fresh start", () => {
    const assembler = new UpdateAssembler();
    assembler.push(part({ updateId: 20, baseUpdateId: 0, partIndex: 0, partCount: 2, updateBytes: 18 }));

    const delta = assembler.push(part({ updateId: 21, baseUpdateId: 20, partIndex: 1, partCount: 2 }));
    expect(delta.resync).toBe("PART_GAP");

    const restart = assembler.push(part({ updateId: 21, baseUpdateId: 20, partIndex: 0, partCount: 2 }));
    expect(restart.resync).toBeNull();
    expect(restart.update).toBeNull();
  });

  it("enforces the configured region cap across parts", () => {
    const assembler = new UpdateAssembler({ maxRegions: 1 });
    const first = assembler.push(
      part({ partIndex: 0, partCount: 2, updateBytes: 18, regions: [region()] }),
    );
    expect(first.resync).toBeNull();

    const second = assembler.push(
      part({
        partIndex: 1,
        partCount: 2,
        updateBytes: 18,
        regions: [region({ x: 2, width: 1 })],
      }),
    );
    expect(second.resync).toBe("INCOMPLETE_UPDATE");
  });

  it("validates every part before it can join an assembly", () => {
    const assembler = new UpdateAssembler();
    const bad = assembler.push(part({ codec: 3 }));
    expect(bad.resync).toBe("UNKNOWN_CODEC");
    expect(bad.update).toBeNull();

    // The rejected part left no partial state behind.
    const good = assembler.push(part());
    expect(good.update?.updateId).toBe(2);
  });

  it("self-contained drops the partial assembly", () => {
    const assembler = new UpdateAssembler();
    assembler.push(part({ partIndex: 0, partCount: 2, updateBytes: 18 }));
    assembler.reset();

    const continuation = assembler.push(part({ partIndex: 1, partCount: 2, updateBytes: 18 }));
    expect(continuation.resync).toBe("PART_GAP");
  });
});
