/**
 * The hand-marked ground truth for the poppzz measurement.
 *
 * Boxes are in the coordinates of `ritz-640.png` — the Ritz photo at the
 * size the app's mask copy actually is (640×480, a third of the long edge
 * of the 2271×1703 original, clamped at 640).
 *
 * SUBJECTS are the things poppzz is supposed to find. BACKGROUND is the
 * things it must not: the bench, the tree trunk, the pavement, the sky, the
 * other shrines, the crowd and the lawn. A mask that covers a background
 * region is a false positive, however plausible it looks.
 */
export interface Box {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const SUBJECTS: Box[] = [
  { name: 'pink shrine', x0: 175, y0: 112, x1: 232, y1: 205 },
  { name: 'sari woman (fore)', x0: 320, y0: 228, x1: 412, y1: 468 },
  { name: 'woman right', x0: 534, y0: 143, x1: 588, y1: 284 },
];

export const BACKGROUND: Box[] = [
  { name: 'bench', x0: 35, y0: 252, x1: 108, y1: 318 },
  { name: 'tree trunk', x0: 225, y0: 0, x1: 340, y1: 128 },
  { name: 'pavement', x0: 140, y0: 380, x1: 320, y1: 462 },
  { name: 'sky TL', x0: 0, y0: 0, x1: 120, y1: 70 },
  { name: 'other shrines', x0: 255, y0: 95, x1: 500, y1: 215 },
  { name: 'crowd', x0: 425, y0: 140, x1: 532, y1: 245 },
  { name: 'lawn', x0: 0, y0: 400, x1: 90, y1: 478 },
];

/**
 * OPTIONAL is for things that are neither clearly a subject nor clearly
 * background — architecture that a viewer might reasonably call either.
 * They are measured and reported, but they never decide pass or fail.
 */
export const OPTIONAL: Box[] = [];

/** A subject counts as found if the mask covers at least this share of it. */
export const COVERAGE_THRESHOLD = 0.05;

/**
 * A mask may not cover more than this share of the background it was told
 * about. A mask that touches a background region is a false positive,
 * however plausible it looks.
 */
export const CONTAMINATION_CEILING = 0.05;
