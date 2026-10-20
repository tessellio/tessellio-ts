import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as Tools from "@tessellio/proto";

import { UpdateAssembler } from "./update-parts";
import {
  MAX_REGION_OPS_BYTES,
  MAX_REGION_WIRE_BYTES,
  applyOps,
  decompressAndValidate,
  validateOpStream,
  type DecodeResult,
  type ResyncReason,
} from "./op-stream";

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const normalized = hex.replaceAll(" ", "").replaceAll("\n", "");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalHex(hex: string): string {
  return hex.replaceAll(" ", "").replaceAll("\n", "").toLowerCase();
}

/** The little-endian the 16-bit cell format byte view of a decoded canvas, as hex. */
function cellsToHex(cells: Uint16Array): string {
  const bytes = new Uint8Array(cells.length * 2);
  for (let index = 0; index < cells.length; index += 1) {
    bytes[index * 2] = cells[index] & 0xff;
    bytes[index * 2 + 1] = cells[index] >> 8;
  }
  return bytesToHex(bytes);
}

/**
 * The corpus's canvas checksum for updates too large to record as cell hex:
 * IEEE CRC-32 (reflected polynomial `0xedb88320`, init/final `0xffffffff`)
 * over the little-endian the 16-bit cell format wire bytes — the same variant the Rust
 * consumer (`codec_conformance.rs`) and the corpus generator
 * (`codec_corpus_gen.rs`) compute.
 */
function surfaceCrc32(cells: Uint16Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < cells.length; index += 1) {
    const value = cells[index];
    for (let shift = 0; shift < 16; shift += 8) {
      crc ^= (value >> shift) & 0xff;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One stored-DEFLATE block (`BFINAL=1`, `BTYPE=00`): the conformance vectors
 * use this envelope so every byte is hand-derivable.
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

async function decodePayload(
  payload: Uint8Array,
  region: { width: number; height: number },
  coverage: "full" | "sparse",
): Promise<{ result: DecodeResult; ops: Uint8Array | null }> {
  const sink: { ops: Uint8Array | null } = { ops: null };
  const result = await decompressAndValidate(payload, region, coverage, sink);
  return { result, ops: sink.ops };
}

function expectReject(
  result: DecodeResult,
  reason: Extract<ResyncReason, "DECODE_ERROR" | "COVERAGE_INVALID">,
): void {
  expect(result).toEqual({ ok: false, reason });
}

function expectedCanvas(width: number, height: number, writes: Array<[number, number, number[]]>): Uint16Array {
  const canvas = new Uint16Array(width * height);
  for (const [x, y, values] of writes) {
    values.forEach((value, index) => {
      canvas[y * width + x + index] = value;
    });
  }
  return canvas;
}

/**
 * Hand-derived conformance vectors (design §9.1). Each vector's proto bytes,
 * op stream, and expected cells are transcribed from the specification; the
 * test walks the whole receiver path — protobuf decode, part parse and
 * validate, assembly, bounded decompress, op validation, application — so a
 * divergence anywhere in that chain fails here.
 */
const vectors = {
  emptyDelta: {
    bytes: "08 07 10 06 18 08 20 04 30 01 40 08",
  },
  literalSpan: {
    header: "08 02 10 01 18 08 20 04 30 01 38 16 40 08 4a 20 08 02 10 01 18 04 20 02 2a 16",
    proto: "08 02 10 01 18 08 20 04 30 01 38 16 40 08 4a 20 08 02 10 01 18 04 20 02 2a 16",
    ops: "01 00 00 02 00 00 04 00 00 F8 E0 07 1F 00 FF FF 00",
    payload: "01 11 00 EE FF 01 00 00 02 00 00 04 00 00 F8 E0 07 1F 00 FF FF 00",
    box: { x: 2, y: 1, width: 4, height: 2 },
  },
  fullCoverageFill: {
    header: "08 03 18 06 20 03 30 01 38 24 40 08 4a 2A 18 06 20 03 2A 24",
    ops:
      "01 00 00 03 00 00 06 00 00 00 " +
      "01 01 00 03 00 00 06 00 FF FF " +
      "01 02 00 03 00 00 06 00 10 84 " +
      "00",
    payload:
      "01 1F 00 E0 FF " +
      "01 00 00 03 00 00 06 00 00 00 " +
      "01 01 00 03 00 00 06 00 FF FF " +
      "01 02 00 03 00 00 06 00 10 84 " +
      "00",
  },
  twoRegions: {
    header: "08 09 10 08 18 08 20 04 30 01 38 2E 40 08 4a 24 18 08 20 02 2a 1E",
    regionA: {
      ops: "01 00 00 02 01 00 02 00 1F F8 FF 07 01 01 00 02 06 00 02 00 1F F8 FF 07 00",
      payload:
        "01 19 00 E6 FF 01 00 00 02 01 00 02 00 1F F8 FF 07 01 01 00 02 06 00 02 00 1F F8 FF 07 00",
      box: { x: 0, y: 0, width: 8, height: 2 },
    },
    regionB: {
      header: "4a 18 10 02 18 08 20 02 2a 10",
      ops: "01 00 00 02 03 00 01 00 00 00 00",
      payload: "01 0B 00 F4 FF 01 00 00 02 03 00 01 00 00 00 00",
      box: { x: 0, y: 2, width: 8, height: 2 },
    },
  },
  twoParts: {
    part0:
      "08 0A 10 09 18 08 20 04 30 02 38 20 40 08 4a 1A 08 01 10 01 18 01 20 01 2A 10 " +
      "01 0B 00 F4 FF 01 00 00 02 00 00 01 00 00 F8 00",
    part1:
      "08 0A 10 09 18 08 20 04 28 01 30 02 38 20 40 08 4A 18 08 02 18 01 20 01 2A 10 " +
      "01 0B 00 F4 FF 01 00 00 02 00 00 01 00 E0 07 00",
  },
} as const;

describe("hand-derived conformance vectors", () => {
  it("V1 accepts an empty delta as a valid update", () => {
    const bytes = hexToBytes(vectors.emptyDelta.bytes);
    const decoded = Tools.Update.decode(bytes);

    expect(decoded.updateId).toBe(7);
    expect(decoded.baseUpdateId).toBe(6);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(4);
    expect(decoded.partIndex).toBe(0);
    expect(decoded.partCount).toBe(1);
    expect(decoded.updateBytes).toBe(0);
    expect(decoded.codec).toBe(Tools.Codec.CODEC_TESSELLIO);
    expect(decoded.regions).toHaveLength(0);

    // (b) canonical re-encoding reproduces the documented bytes.
    expect(bytesToHex(Tools.Update.encode(decoded).finish())).toBe(
      canonicalHex(vectors.emptyDelta.bytes),
    );
  });

  it("V2 decodes a literal SPAN into the expected cells", async () => {
    const payload = hexToBytes(vectors.literalSpan.payload);
    const proto = hexToBytes(`${vectors.literalSpan.header} ${bytesToHex(payload)}`);
    const decoded = Tools.Update.decode(proto);

    expect(decoded.updateId).toBe(2);
    expect(decoded.baseUpdateId).toBe(1);
    expect(decoded.updateBytes).toBe(22);
    expect(decoded.regions).toHaveLength(1);
    expect(decoded.regions[0].x).toBe(2);
    expect(decoded.regions[0].y).toBe(1);
    expect(decoded.regions[0].width).toBe(4);
    expect(decoded.regions[0].height).toBe(2);
    expect(bytesToHex(decoded.regions[0].payload)).toBe(canonicalHex(vectors.literalSpan.payload));
    expect(bytesToHex(Tools.Update.encode(decoded).finish())).toBe(bytesToHex(proto));

    const { result, ops } = await decodePayload(payload, { width: 4, height: 2 }, "sparse");
    expect(result).toEqual({ ok: true });
    expect(bytesToHex(ops ?? new Uint8Array())).toBe(canonicalHex(vectors.literalSpan.ops));

    const canvas = new Uint16Array(8 * 4);
    if (ops) {
      applyOps(ops, vectors.literalSpan.box, canvas, 8);
    }

    const expected = expectedCanvas(8, 4, [
      [2, 1, [0xf800, 0x07e0, 0x001f, 0xffff]],
    ]);
    expect(cellsToHex(canvas)).toBe(cellsToHex(expected));
  });

  it("V3 paints every row of a full-coverage reset update", async () => {
    const payload = hexToBytes(vectors.fullCoverageFill.payload);
    const proto = hexToBytes(`${vectors.fullCoverageFill.header} ${bytesToHex(payload)}`);
    const decoded = Tools.Update.decode(proto);

    expect(decoded.updateId).toBe(3);
    expect(decoded.baseUpdateId).toBe(0);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(3);
    expect(decoded.updateBytes).toBe(36);
    expect(decoded.regions[0].width).toBe(6);
    expect(decoded.regions[0].height).toBe(3);
    expect(bytesToHex(Tools.Update.encode(decoded).finish())).toBe(bytesToHex(proto));
    expect(bytesToHex(decoded.regions[0].payload)).toBe(canonicalHex(vectors.fullCoverageFill.payload));

    const { result, ops } = await decodePayload(payload, { width: 6, height: 3 }, "full");
    expect(result).toEqual({ ok: true });

    const canvas = new Uint16Array(6 * 3);
    if (ops) {
      applyOps(ops, { x: 0, y: 0, width: 6, height: 3 }, canvas, 6);
    }

    // Three fully painted rows: black, white, 0x8410 (132, 130, 132).
    const expected = expectedCanvas(6, 3, [
      [0, 0, [0, 0, 0, 0, 0, 0]],
      [0, 1, [0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff]],
      [0, 2, [0x8410, 0x8410, 0x8410, 0x8410, 0x8410, 0x8410]],
    ]);
    expect(cellsToHex(canvas)).toBe(cellsToHex(expected));
  });

  it("V4 paints two sparse regions and leaves the skipped rows untouched", async () => {
    const payloadA = hexToBytes(vectors.twoRegions.regionA.payload);
    const payloadB = hexToBytes(vectors.twoRegions.regionB.payload);
    const proto = hexToBytes(
      `${vectors.twoRegions.header} ${bytesToHex(payloadA)} ${vectors.twoRegions.regionB.header} ${bytesToHex(payloadB)}`,
    );
    const decoded = Tools.Update.decode(proto);

    expect(decoded.updateId).toBe(9);
    expect(decoded.baseUpdateId).toBe(8);
    expect(decoded.updateBytes).toBe(46);
    expect(decoded.regions).toHaveLength(2);
    expect(decoded.regions[0]).toMatchObject({ x: 0, y: 0, width: 8, height: 2 });
    expect(decoded.regions[1]).toMatchObject({ x: 0, y: 2, width: 8, height: 2 });
    expect(bytesToHex(Tools.Update.encode(decoded).finish())).toBe(bytesToHex(proto));

    const canvas = new Uint16Array(8 * 4);
    for (const [payload, box] of [
      [payloadA, vectors.twoRegions.regionA.box],
      [payloadB, vectors.twoRegions.regionB.box],
    ] as const) {
      const { result, ops } = await decodePayload(payload, { width: box.width, height: box.height }, "sparse");
      expect(result).toEqual({ ok: true });
      if (ops) {
        applyOps(ops, box, canvas, 8);
      }
    }

    const expected = expectedCanvas(8, 4, [
      [1, 0, [0xf81f, 0x07ff]],
      [6, 1, [0xf81f, 0x07ff]],
      [3, 2, [0x0000]],
    ]);
    expect(cellsToHex(canvas)).toBe(cellsToHex(expected));
  });

  it("V5 applies a two-part update only after both parts", async () => {
    const part0 = Tools.Update.decode(hexToBytes(vectors.twoParts.part0));
    const part1 = Tools.Update.decode(hexToBytes(vectors.twoParts.part1));

    expect(part0.updateId).toBe(10);
    expect(part0.baseUpdateId).toBe(9);
    expect(part0.partIndex).toBe(0);
    expect(part1.partIndex).toBe(1);
    expect(part0.partCount).toBe(2);
    expect(part1.partCount).toBe(2);
    expect(part0.updateBytes).toBe(32);
    expect(part1.updateBytes).toBe(32);
    expect(part0.regions[0]).toMatchObject({ x: 1, y: 1, width: 1, height: 1 });
    expect(part1.regions[0]).toMatchObject({ x: 2, y: 0, width: 1, height: 1 });
    expect(
      bytesToHex(Tools.Update.encode(part0).finish()),
    ).toBe(canonicalHex(vectors.twoParts.part0));
    expect(
      bytesToHex(Tools.Update.encode(part1).finish()),
    ).toBe(canonicalHex(vectors.twoParts.part1));

    const canvas = new Uint16Array(8 * 4);
    for (const part of [part0, part1]) {
      for (const region of part.regions) {
        const { result, ops } = await decodePayload(
          region.payload,
          { width: region.width, height: region.height },
          "sparse",
        );
        expect(result).toEqual({ ok: true });
        if (ops) {
          applyOps(ops, { x: region.x, y: region.y, width: region.width, height: region.height }, canvas, 8);
        }
      }
    }

    const expected = expectedCanvas(8, 4, [
      [1, 1, [0xf800]],
      [2, 0, [0x07e0]],
    ]);
    expect(cellsToHex(canvas)).toBe(cellsToHex(expected));
  });
});

describe("validateOpStream coverage modes", () => {
  const box = { width: 6, height: 3 };
  const fullOps = hexToBytes(vectors.fullCoverageFill.ops);

  it("accepts the full-coverage stream in full mode", async () => {
    const { result } = await decodePayload(storedDeflate(fullOps), box, "full");
    expect(result).toEqual({ ok: true });
  });

  it("rejects a missing row in full mode", async () => {
    const ops = hexToBytes(
      "01 00 00 03 00 00 06 00 00 00 " + "01 02 00 03 00 00 06 00 10 84 " + "00",
    );
    const { result } = await decodePayload(storedDeflate(ops), box, "full");
    expectReject(result, "COVERAGE_INVALID");
  });

  it("rejects a gap inside a row in full mode", async () => {
    const ops = hexToBytes(
      "01 00 00 03 00 00 06 00 00 00 " +
        "01 01 00 03 01 00 04 00 FF FF " +
        "01 02 00 03 00 00 06 00 10 84 " +
        "00",
    );
    const { result } = await decodePayload(storedDeflate(ops), box, "full");
    expectReject(result, "COVERAGE_INVALID");
  });

  it("rejects a row that stops short of the width in full mode", async () => {
    const ops = hexToBytes("01 00 00 03 00 00 05 00 00 00 00");
    const { result } = await decodePayload(storedDeflate(ops), { width: 6, height: 1 }, "full");
    expectReject(result, "COVERAGE_INVALID");
  });

  it("rejects a stream whose first ROW is not row 0 in full mode", async () => {
    const ops = hexToBytes("01 01 00 03 00 00 06 00 00 00 00");
    const { result } = await decodePayload(storedDeflate(ops), { width: 6, height: 2 }, "full");
    expectReject(result, "COVERAGE_INVALID");
  });

  it("accepts a sparse subset of the same rows", async () => {
    const ops = hexToBytes("01 01 00 02 01 00 02 00 1F F8 FF 07 00");
    const { result } = await decodePayload(storedDeflate(ops), { width: 8, height: 4 }, "sparse");
    expect(result).toEqual({ ok: true });
  });

  it("accepts an empty op stream only in sparse mode", async () => {
    const sparse = await decodePayload(storedDeflate(new Uint8Array([0x00])), box, "sparse");
    expect(sparse.result).toEqual({ ok: true });
    const full = await decodePayload(storedDeflate(new Uint8Array([0x00])), box, "full");
    expectReject(full.result, "COVERAGE_INVALID");
  });
});

describe("malformed op streams", () => {
  const box = { width: 8, height: 4 };

  it("rejects a ROW that does not increase", async () => {
    const ops = hexToBytes("01 01 00 01 01 00 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects a ROW at or beyond the region height", async () => {
    const ops = hexToBytes("01 04 00 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects a writing op before any ROW", async () => {
    const ops = hexToBytes("03 00 00 01 00 00 00 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects a zero-length run", async () => {
    const ops = hexToBytes("01 00 00 03 00 00 00 00 00 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects a run that overflows the region width", async () => {
    const span = hexToBytes("01 00 00 02 06 00 04 00 1F F8 FF 07 1F F8 FF 07 00");
    const fill = hexToBytes("01 00 00 03 06 00 04 00 00 00 00");
    expectReject((await decodePayload(storedDeflate(span), box, "sparse")).result, "DECODE_ERROR");
    expectReject((await decodePayload(storedDeflate(fill), box, "sparse")).result, "DECODE_ERROR");
  });

  it("rejects overlapping runs on one row", async () => {
    const ops = hexToBytes(
      "01 00 00 02 00 00 04 00 00 F8 E0 07 1F 00 FF FF " + "02 03 00 02 00 1F F8 FF 07 " + "00",
    );
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects truncated operands and cells", async () => {
    const truncatedRow = hexToBytes("01 00");
    const truncatedSpan = hexToBytes("01 00 00 02 00 00 04 00 00 F8");
    const truncatedFill = hexToBytes("01 00 00 03 00 00 01 00 00");
    expectReject((await decodePayload(storedDeflate(truncatedRow), box, "sparse")).result, "DECODE_ERROR");
    expectReject((await decodePayload(storedDeflate(truncatedSpan), box, "sparse")).result, "DECODE_ERROR");
    expectReject((await decodePayload(storedDeflate(truncatedFill), box, "sparse")).result, "DECODE_ERROR");
  });

  it("rejects bytes after the first END", async () => {
    const ops = hexToBytes("00 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects a stream without END", async () => {
    const ops = hexToBytes("01 00 00 03 00 00 08 00 00 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects an unknown op byte", async () => {
    const ops = hexToBytes("04 00");
    const { result } = await decodePayload(storedDeflate(ops), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects a payload that is not DEFLATE at all", async () => {
    const { result } = await decodePayload(new Uint8Array([0xff, 0xff, 0xff, 0xff]), box, "sparse");
    expectReject(result, "DECODE_ERROR");
  });

  it("rejects an empty payload and an over-cap payload before inflating", async () => {
    const empty = await decodePayload(new Uint8Array(0), box, "sparse");
    expectReject(empty.result, "DECODE_ERROR");

    const oversized = new Uint8Array(MAX_REGION_WIRE_BYTES + 1).fill(0x01);
    const oversizedResult = await decodePayload(oversized, box, "sparse");
    expectReject(oversizedResult.result, "DECODE_ERROR");
  });

  it("never leaks a partially decoded stream to the sink", async () => {
    const sink: { ops: Uint8Array | null } = { ops: null };
    const result = await decompressAndValidate(hexToBytes("01 11 00 EE FF FF FF"), box, "sparse", sink);
    expect(result.ok).toBe(false);
    expect(sink.ops).toBeNull();
  });
});

describe("bounded decompression", () => {
  async function deflate(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
    const stream = source.pipeThrough(new CompressionStream("deflate-raw"));
    const parts: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        parts.push(value);
      }
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const compressed = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      compressed.set(part, offset);
      offset += part.byteLength;
    }
    return compressed;
  }

  it("accepts a compressed op stream from a real DEFLATE encoder", async () => {
    const ops = hexToBytes(vectors.fullCoverageFill.ops);
    const compressed = await deflate(ops);

    const { result, ops: decoded } = await decodePayload(compressed, { width: 6, height: 3 }, "full");
    expect(result).toEqual({ ok: true });
    expect(bytesToHex(decoded ?? new Uint8Array())).toBe(bytesToHex(ops));
  });

  it("aborts when the decompressed stream exceeds the ops cap", async () => {
    const oversized = new Uint8Array(MAX_REGION_OPS_BYTES + 1);
    const compressed = await deflate(oversized);
    expect(compressed.byteLength).toBeLessThan(MAX_REGION_WIRE_BYTES);

    const { result, ops } = await decodePayload(compressed, { width: 8, height: 4 }, "sparse");
    expectReject(result, "DECODE_ERROR");
    expect(ops).toBeNull();
  });

  it("reports a decode error instead of skipping when deflate-raw is unavailable", async () => {
    // Documented contingency: a runtime without `DecompressionStream` cannot
    // inflate a region. The receiver treats that as a decode error and asks for
    // a resync; it never applies the update and never skips it silently.
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      const { result, ops } = await decodePayload(
        hexToBytes(vectors.fullCoverageFill.payload),
        { width: 6, height: 3 },
        "full",
      );
      expectReject(result, "DECODE_ERROR");
      expect(ops).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("applyOps", () => {
  it("writes literals and fills at absolute coordinates with the caller's stride", () => {
    const ops = hexToBytes(
      "01 00 00 03 00 00 02 00 10 84 " + "02 04 00 02 00 1F F8 FF 07 " + "00",
    );
    const target = new Uint16Array(10 * 6);
    applyOps(ops, { x: 2, y: 1, width: 6, height: 3 }, target, 10);

    expect(target[1 * 10 + 2]).toBe(0x8410);
    expect(target[1 * 10 + 3]).toBe(0x8410);
    expect(target[1 * 10 + 6]).toBe(0xf81f);
    expect(target[1 * 10 + 7]).toBe(0x07ff);
    expect(target[0]).toBe(0);
    expect(target[9]).toBe(0);
  });

  it("clips runs that fall outside the supplied target", () => {
    const ops = hexToBytes("01 00 00 03 00 00 04 00 FF FF 00");
    const target = new Uint16Array(2);
    applyOps(ops, { x: 0, y: 0, width: 4, height: 1 }, target, 4);
    expect(Array.from(target)).toEqual([0xffff, 0xffff]);
  });

  it("validates and applies through the same walk", () => {
    const ops = hexToBytes(vectors.literalSpan.ops);
    expect(validateOpStream(ops, { width: 4, height: 2 }, "sparse")).toEqual({ ok: true });

    const target = new Uint16Array(8 * 2);
    applyOps(ops, vectors.literalSpan.box, target, 8);
    expect(target.slice(8 + 2, 8 + 6)).toEqual(Uint16Array.from([0xf800, 0x07e0, 0x001f, 0xffff]));
  });

  it("throws instead of applying a malformed stream", () => {
    // The second run starts before the first one ends: the walk rejects the
    // stream, and the caller must not treat the partially written target as a
    // update.
    const ops = hexToBytes("01 00 00 03 00 00 03 00 FF FF " + "02 01 00 02 00 1F F8 FF 07 " + "00");
    const target = new Uint16Array(4);

    expect(() => applyOps(ops, { x: 0, y: 0, width: 4, height: 1 }, target, 4)).toThrow(
      "malformed op stream",
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The committed corpus is the second implementation's cross-check: it is read
 * from its canonical location in the repository, never copied here, and it is a
 * committed file the gate verifies (`just codec-vectors` checks the schema and
 * the cross-reference to this path; the cargo gate regenerates it and requires
 * byte equality). A missing or unreadable corpus is therefore a failure, not a
 * skipped case: the hand-derived vectors above stay the executing evidence for
 * the format itself, and every corpus case runs below.
 */
// `new URL` is reserved for protocol boundaries, so the canonical corpus is
// resolved from this module's own directory.
const corpusPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tessellio-conformance/corpus.json",
);
const corpus = readCorpus();

type CorpusRegion = { x: number; y: number; width: number; height: number; payload: string };
type CorpusPart = { index: number; count: number; updateBytes: number; regions: CorpusRegion[] };
type CorpusUpdate = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  parts: CorpusPart[];
  expect?: { cells565?: string; surfaceBytes?: number; surfaceCrc32?: string; ack?: boolean };
};
/** A standalone part fixture (the `part`/`parts` expect-error shapes). */
type CorpusPartIdentity = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  partIndex: number;
  partCount: number;
  updateBytes: number;
  codec: number;
  regions: CorpusRegion[];
};
type CorpusCase = {
  id: string;
  mode: "roundtrip" | "expect-error";
  updates?: CorpusUpdate[];
  reason?: ResyncReason;
  payload?: string;
  region?: { width: number; height: number };
  coverage?: "full" | "sparse";
  part?: CorpusPartIdentity;
  parts?: CorpusPartIdentity[];
};

/**
 * The corpus records the receiver's wire reason. The receiver's `ResyncReason`
 * union is deliberately coarser than the receiver's per-step codes: a framing
 * failure the receiver reports as `BASE_MISMATCH` (a bad base) or
 * `DECODE_ERROR` (an identity field, a mis-sequenced part) reaches the
 * receiver's assembler as `PART_GAP`, and both heal identically sender-side. Only
 * these two reasons admit the coarser answer; every other case is asserted
 * exactly.
 */
const RECEIVER_REASON_EQUIVALENTS: Partial<Record<ResyncReason, ResyncReason[]>> = {
  BASE_MISMATCH: ["BASE_MISMATCH", "PART_GAP"],
  DECODE_ERROR: ["DECODE_ERROR", "PART_GAP"],
};

/** Convert one corpus part fixture into the assembler's input shape. */
function toUpdatePart(raw: CorpusPartIdentity) {
  return {
    updateId: raw.updateId,
    baseUpdateId: raw.baseUpdateId,
    width: raw.width,
    height: raw.height,
    partIndex: raw.partIndex,
    partCount: raw.partCount,
    updateBytes: raw.updateBytes,
    codec: raw.codec,
    regions: raw.regions.map((entry) => ({
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      payload: hexToBytes(entry.payload),
    })),
  };
}

function readCorpus(): { cases: CorpusCase[] } | null {
  try {
    const text = fs.readFileSync(corpusPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const cases = (parsed as { cases?: unknown }).cases;
    return Array.isArray(cases) ? { cases: cases as CorpusCase[] } : null;
  } catch {
    return null;
  }
}

if (corpus === null) {
  describe("conformance corpus", () => {
    it("corpus.json is committed and readable", () => {
      expect(corpus).not.toBeNull();
    });
  });
} else {
  describe("conformance corpus", () => {
    for (const testCase of corpus.cases) {
      it(`${testCase.id} (${testCase.mode})`, async () => {
        if (testCase.mode === "expect-error") {
          // A part-level or assembly-level rejection is exercised through the
          // assembler — the receiver's real entry point for a part — rather than
          // through a region payload it does not carry.
          if (testCase.part !== undefined || testCase.parts !== undefined) {
            const assembler = new UpdateAssembler();
            let resync: ResyncReason | null = null;
            const fixtures = testCase.parts ?? [testCase.part as CorpusPartIdentity];
            for (const fixture of fixtures) {
              const pushed = assembler.push(toUpdatePart(fixture));
              resync = pushed.resync ?? resync;
            }
            expect(resync).not.toBeNull();
            const accepted = (testCase.reason && RECEIVER_REASON_EQUIVALENTS[testCase.reason])
              ?? [testCase.reason];
            expect(accepted).toContain(resync);
            return;
          }
          // A coverage violation only exists in the mode that requires full
          // coverage; every other error kind is mode-independent.
          const coverage =
            testCase.coverage ?? (testCase.reason === "COVERAGE_INVALID" ? "full" : "sparse");
          const region = testCase.region ?? { width: 4, height: 1 };
          const { result, ops } = await decodePayload(
            hexToBytes(testCase.payload ?? ""),
            region,
            coverage,
          );
          expect(result.ok).toBe(false);
          expect(result.ok ? "" : result.reason).toBe(testCase.reason);
          expect(ops).toBeNull();
          return;
        }

        const canvas = new Uint16Array(
          (testCase.updates?.[0]?.width ?? 0) * (testCase.updates?.[0]?.height ?? 0),
        );
        for (const update of testCase.updates ?? []) {
          const width = update.width;
          const height = update.height;
          const assembler = new UpdateAssembler();
          let assembled = null;
          for (const part of update.parts) {
            const pushed = assembler.push({
              updateId: update.updateId,
              baseUpdateId: update.baseUpdateId,
              width,
              height,
              partIndex: part.index,
              partCount: part.count,
              updateBytes: part.updateBytes,
              codec: 8,
              regions: part.regions.map((entry) => ({
                x: entry.x,
                y: entry.y,
                width: entry.width,
                height: entry.height,
                payload: hexToBytes(entry.payload),
              })),
            });
            expect(pushed.resync).toBeNull();
            if (pushed.update) {
              assembled = pushed.update;
            }
          }

          expect(assembled).not.toBeNull();
          const coverage = update.baseUpdateId === 0 ? "full" : "sparse";
          for (const entry of assembled?.regions ?? []) {
            const { result, ops } = await decodePayload(
              entry.payload,
              { width: entry.width, height: entry.height },
              coverage,
            );
            expect(result).toEqual({ ok: true });
            if (ops) {
              applyOps(ops, entry, canvas, width);
            }
          }

          if (update.expect?.cells565) {
            expect(cellsToHex(canvas)).toBe(canonicalHex(update.expect.cells565));
          } else {
            // A large canvas records its exact byte length and CRC instead of
            // the full cell hex; both are verified, exactly as the Rust
            // consumer does. The branch is exhaustive on purpose: a update
            // with neither expectation is a corpus defect, not a pass.
            const expected = update.expect;
            expect(expected?.surfaceCrc32).toMatch(/^[0-9a-f]{8}$/);
            expect(canvas.byteLength).toBe(expected?.surfaceBytes);
            expect(surfaceCrc32(canvas).toString(16).padStart(8, "0")).toBe(
              expected?.surfaceCrc32,
            );
          }
        }
      });
    }
  });
}
