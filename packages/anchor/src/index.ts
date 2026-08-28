export const ANCHOR_FORMAT_VERSION = 1;

export { CONTEXT_RADIUS, GAP } from "./types.js";
export type { Anchor, AnchorTarget, Relocation, Window } from "./types.js";
export { createAnchor, fingerprint, normalizeLine, windowAt } from "./fingerprint.js";
