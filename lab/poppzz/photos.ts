/**
 * The photographs the harness measures, and how they were prepared.
 *
 * Each one is a real photograph downscaled to the size the app's mask copy
 * actually is — a third of the long edge, clamped at 640 — so the harness
 * measures the pipeline on the same pixels the browser would. The full-size
 * originals live in `lab/shots/`.
 *
 *   node lab/poppzz/verify.ts temple
 */
export interface PhotoSpec {
  /** the key this photo is known by on the command line */
  key: string;
  /** the downscaled fixture, next to the harness */
  file: string;
  /** the width of the original photograph, for the source-pixel blur */
  srcWidth: number;
  /** the module holding the hand-marked boxes */
  groundTruth: string;
  /** the full-size original, for making the fixture again */
  source: string;
}

export const PHOTOS: PhotoSpec[] = [
  {
    key: 'ritz',
    file: 'ritz-640.png',
    srcWidth: 2271,
    groundTruth: 'ground-truth',
    source: '../shots/ritz-carlton-bangalore.jpg',
  },
  {
    key: 'temple',
    file: 'temple-640.png',
    srcWidth: 4608,
    groundTruth: 'ground-truth-temple',
    source: '../shots/temple-oneplus.jpg',
  },
];

/**
 * Make a fixture from a full-size original:
 *
 *   sips -Z 640 -s format png --out lab/poppzz/<name>-640.png lab/shots/<file>.jpg
 */
export const FIXTURE_EDGE = 640;
