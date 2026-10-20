/**
 * Tessellio: the browser-side screen codec.
 *
 * The codec's byte grammar is defined once, in the specification, and
 * implemented here for the browser. The Rust implementation in `tessellio-core`
 * is the source of truth for every number and every rule; this package is its
 * mirror.
 *
 * - {@link module:op-stream} — the region op-stream decoder and the coverage
 *   rules.
 * - {@link module:update-parts} — the part assembler and the update's
 *   validation.
 * - {@link module:surface} — the surface the receiver draws on.
 * - {@link module:surface-stream} — the codec's surface stream: the parts of
 *   an update applied and painted, and the state they leave behind.
 */

export * from "./op-stream";
export * from "./surface-stream";
export * from "./update-parts";
export * from "./surface";
