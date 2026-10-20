# Tessellio TS

The browser-side implementation of the **Tessellio** screen codec.

Tessellio paints a surface as tiles of cells and moves only the tiles that
changed. This package decodes what the codec produces and draws it on a
surface.

The codec's byte grammar is defined once, in the specification, and
implemented here for the browser. The Rust implementation in
[`tessellio-core`](https://github.com/tessellio/tessellio-core) is the source
of truth for every number and every rule; this package is its mirror.

## What is in the package

| Module | What it holds |
|---|---|
| `op-stream` | the region op-stream decoder and the coverage rules |
| `update-parts` | the part assembler and the update's validation |
| `surface` | the surface the receiver draws on |
| `surface-stream` | the codec's surface stream: the parts of an update applied and painted, and the state they leave behind |

The receiver-side state machine — the part that reads a transport's chunk
metadata and answers with the transport's acknowledgement window — is not
here: it belongs to the transport, which depends on the codec, not the other
way round.

## The surface stream

`SurfaceStream` is the codec's half of a receiver, and the half that knows
the codec: it takes the codec's own envelope — one part of one update — and
paints it.

```ts
import { SurfaceStream } from "@tessellio/ts";

const stream = new SurfaceStream({
  renderer,
  onApplied: (report) => {
    // report.updateId, report.appliedCellCount, report.renderLatencyMs
  },
  onFailure: (failure) => {
    // failure.reason is "PART_GAP" or "INCOMPLETE_UPDATE"
  },
});

stream.applyPart(part, { anchor });
```

An update is applied whole: its parts are assembled, every region is
inflated and validated before the first cell is written, the regions are
painted, and only then is the update reported as applied. An update that
cannot be applied is refused whole, and the refusal names the update the
surface still holds.

The stream knows nothing about the transport. It holds no chain epoch, no
acknowledgement window, and no repair request: those belong to the
transport's half, which depends on this package and never the other way
round. The application wires the two together — one tells the other what it
applied, and the other answers with what the transport owes.

## Using it

```ts
import { UpdateAssembler, decodeRegionInto } from "@tessellio/ts";
```

`UpdateAssembler` collects the parts of an update and validates the result
as a whole; `decodeRegionInto` walks a region's op stream and paints the
cells it names. An update is applied whole: every part of it, or none.

## Verifying it

```sh
npm test        # the unit suites and the corpus consumer
npm run typecheck
```

The corpus the browser suite reads is the one committed in
[`tessellio-conformance`](https://github.com/tessellio/tessellio-conformance).
A codec that changes a byte cannot pass in one language and fail in the
other, because both read the same file.

## Licence

PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE).
