/**
 * Measure the shipped poppzz pipeline against hand-marked ground truth.
 *
 * This imports `src/filters/poppzz-saliency.ts` — the module the browser
 * actually runs — so what it measures is what ships, not a copy of it. It
 * has no DOM and no WebGL to stand in the way, which is the whole point of
 * keeping the pipeline pure.
 *
 *   npm run lab
 *
 * The photo is the Ritz photo at the size the app's mask copy actually is,
 * and the boxes it scores against are in `ground-truth.ts`.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMask } from '../../src/filters/poppzz-saliency.ts';
import {
  EDGE_PENALTY, MIN_BLOB_FRACTION, MIN_FILL, TERM_FLOOR, W_BORDER, W_COLOR, W_PRIOR, W_RARE,
} from '../../src/filters/poppzz-saliency.ts';
import { BACKGROUND, COVERAGE_THRESHOLD, SUBJECTS } from './ground-truth.ts';
import { decodePNGAsRGBA, writePNG } from './png.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, 'ritz-640.png');
const OUT = join(HERE, 'out', 'mask-preview.png');

/** The width of the original photograph, for the source-pixel blur. */
const SRC_WIDTH = 2271;
const CENTER_WEIGHT = 0.4;
const THRESHOLD = 0;
const SUBJECTS_WANTED = 3;

console.log('shipped constants:',
  `W_RARE=${W_RARE} W_COLOR=${W_COLOR} W_BORDER=${W_BORDER} W_PRIOR=${W_PRIOR}`,
  `TERM_FLOOR=${TERM_FLOOR} MIN_FILL=${MIN_FILL} EDGE_PENALTY=${EDGE_PENALTY}`,
  `MIN_BLOB_FRACTION=${MIN_BLOB_FRACTION}`);

const { data, w, h } = decodePNGAsRGBA(PHOTO);
const n = w * h;

const t0 = performance.now();
const res = buildMask(data, w, h, {
  centerWeight: CENTER_WEIGHT,
  threshold: THRESHOLD,
  subjects: SUBJECTS_WANTED,
}, SRC_WIDTH);
const ms = performance.now() - t0;

console.log(`\nmask ${ms.toFixed(0)} ms   Otsu cut = ${res.cut.toFixed(4)}   kept = ${res.kept.length}`);

for (const b of res.kept) {
  const fill = b.area / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
  const edge = b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1 || b.y1 === h - 1;
  console.log(`   area=${String(b.area).padStart(6)} (${((b.area / n) * 100).toFixed(2)}%)`
    + `  fill=${fill.toFixed(3)}  bbox=[${b.x0},${b.y0}-${b.x1},${b.y1}]  edge=${edge}`);
}

// The kept mask, pixel by pixel: R is the mask itself.
const keptMask = new Uint8Array(n);
for (let i = 0; i < n; i++) if (res.maskPixels[i * 4]) keptMask[i] = 1;

// The background the mask must not touch.
const gtBg = new Uint8Array(n);
for (const b of BACKGROUND) {
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) gtBg[y * w + x] = 1;
  }
}

let keepN = 0, bgHit = 0;
for (let i = 0; i < n; i++) {
  if (keptMask[i]) {
    keepN++;
    if (gtBg[i]) bgHit++;
  }
}
console.log(`\nkept area = ${((keepN / n) * 100).toFixed(2)}% of frame,`
  + ` background contamination = ${((bgHit / keepN) * 100).toFixed(1)}%`);

let found = 0;
console.log('');
for (const s of SUBJECTS) {
  let tot = 0, hit = 0;
  for (let y = s.y0; y < s.y1; y++) {
    for (let x = s.x0; x < s.x1; x++) {
      const i = y * w + x;
      tot++;
      if (keptMask[i]) hit++;
    }
  }
  const f = tot ? hit / tot : 0;
  if (f > COVERAGE_THRESHOLD) found++;
  console.log(`   ${s.name.padEnd(20)} covered ${(f * 100).toFixed(0)}%`);
}
console.log(`\nSUBJECTS FOUND: ${found}/${SUBJECTS.length}`);

// A preview: the kept subjects in green over a dimmed frame.
const rgb = Buffer.alloc(w * h * 3);
for (let i = 0; i < n; i++) {
  const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
  if (keptMask[i]) {
    rgb[i * 3] = Math.round(R * 0.35 + 60);
    rgb[i * 3 + 1] = Math.round(G * 0.35 + 200);
    rgb[i * 3 + 2] = Math.round(B * 0.35 + 60);
  } else {
    rgb[i * 3] = Math.round(R * 0.5);
    rgb[i * 3 + 1] = Math.round(G * 0.5);
    rgb[i * 3 + 2] = Math.round(B * 0.5);
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writePNG(OUT, w, h, rgb);
console.log(`wrote ${OUT}`);

if (found < SUBJECTS.length) {
  console.error(`\nFAILED: only ${found}/${SUBJECTS.length} subjects found`);
  process.exit(1);
}
