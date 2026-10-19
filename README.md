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
| `screen-op` | the region op-stream decoder and the coverage rules |
| `screen-frame` | the chunk assembler and the update's validation |
| `screen-canvas` | the surface the receiver draws on |

The receiver-side state machine — the part that reads a transport's chunk
metadata and answers with the transport's acknowledgement window — is not
here: it belongs to the transport, which depends on the codec, not the other
way round.

## Using it

```ts
import { ScreenFrameAssembler, decodeRegionInto } from "@tessellio/ts";
```

`ScreenFrameAssembler` collects the parts of an update and validates the
result as a whole; `decodeRegionInto` walks a region's op stream and paints
the cells it names. An update is applied whole: every part of it, or none.

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
