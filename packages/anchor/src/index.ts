export const ANCHOR_FORMAT_VERSION = 1;

export { CONTEXT_RADIUS, GAP } from "./types";
export type { Anchor, AnchorTarget, Relocation, Window } from "./types";
export { createAnchor, fingerprint, normalizeLine, windowAt } from "./fingerprint";
export { MIN_DISTINCTIVE_SLOTS, relocate } from "./relocate";
