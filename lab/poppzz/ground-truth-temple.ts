/**
 * The hand-marked ground truth for the temple photograph.
 *
 * Boxes are in the coordinates of `temple-640.png` — the temple photo at the
 * size the app's mask copy actually is (640×480, a third of the long edge of
 * the 4608×3456 original, clamped at 640).
 *
 * The photograph is a selfie: a man in a red shirt fills the left of the
 * frame, a woman in pale blue holds a phone on the right, and behind them
 * stand the temple gopuram and a bank of bougainvillea. The PEOPLE are what
 * poppzz is meant to find; the architecture and the flowers are the backdrop
 * they stand against.
 *
 * The temple is the judgement call. It is a strong, well-formed structure,
 * so a viewer might reasonably call it a subject — and the harness reports
 * its coverage either way. It is marked as background here, because in a
 * portrait the subject is the person, not the building behind them.
 */
import type { Box } from './ground-truth.ts';

export const SUBJECTS: Box[] = [
  { name: 'man head', x0: 5, y0: 18, x1: 215, y1: 258 },
  { name: 'man shirt', x0: 0, y0: 262, x1: 330, y1: 480 },
  { name: 'woman face', x0: 330, y0: 268, x1: 432, y1: 392 },
];

export const BACKGROUND: Box[] = [
  { name: 'sky', x0: 214, y0: 0, x1: 398, y1: 105 },
  { name: 'temple base', x0: 195, y0: 145, x1: 330, y1: 332 },
  { name: 'temple spire', x0: 410, y0: 30, x1: 532, y1: 252 },
  { name: 'bougainvillea', x0: 445, y0: 140, x1: 640, y1: 355 },
];

/**
 * Neither clearly subject nor clearly background: the woman's clothing, the
 * phone in her hand, and the temple spire — which is marked background
 * above but is a defensible subject. These are measured and reported, and
 * they never decide pass or fail.
 */
export const OPTIONAL: Box[] = [
  { name: 'woman top', x0: 295, y0: 372, x1: 480, y1: 480 },
  { name: 'hand + phone', x0: 512, y0: 286, x1: 628, y1: 372 },
];

export const COVERAGE_THRESHOLD = 0.05;
export const CONTAMINATION_CEILING = 0.05;
