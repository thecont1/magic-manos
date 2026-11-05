/**
 * Measure the shipped poppzz pipeline against hand-marked ground truth.
 *
 * This imports `src/filters/poppzz-saliency.ts` — the module the browser
 * actually runs — so what it measures is what ships, not a copy of it. It
 * has no DOM and no WebGL to stand in the way, which is the whole point of
 * keeping the pipeline pure.
 *
 *   npm run lab                          # every photo, at the defaults
 *   node lab/poppzz/verify.ts temple     # one photo
 *   node lab/poppzz/verify.ts temple 0.5 0.06 3
 *                                         # photo, centreWeight, threshold, subjects
 *
 * Each photo is a real photograph at the size the app's mask copy actually
 * is, and the boxes it scores against are in `ground-truth*.ts`.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EDGE_PENALTY, MASK_BLUR_PX, MIN_BLOB_FRACTION, MIN_FILL, MIN_MASS_FRACTION, TERM_FLOOR, W_BORDER, W_COLOR, W_PRIOR, W_RARE,
  blobFill, blobScore, buildMask, computeSaliency, labelBlobs, morph, otsuThreshold,
} from '../../src/filters/poppzz-saliency.ts';
import type { Blob } from '../../src/filters/poppzz-saliency.ts';
import type { Box } from './ground-truth.ts';
import { decodePNGAsRGBA, writePNG } from './png.ts';
import { PHOTOS } from './photos.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface GroundTruth {
  SUBJECTS: Box[];
  BACKGROUND: Box[];
  OPTIONAL: Box[];
  COVERAGE_THRESHOLD: number;
  CONTAMINATION_CEILING: number;
}

/** The defaults the app ships with. */
const DEFAULTS = { centerWeight: 0.4, threshold: 0, subjects: 3 };

/**
 * Reproduce the pipeline's own selection, so the harness can say *why* a
 * blob was dropped. The scored mask still comes from `buildMask` — this is
 * only here to explain the verdict.
 */
function diagnose(
  data: Uint8ClampedArray, w: number, h: number, srcWidth: number,
  centerWeight: number, threshold: number, subjects: number,
): { cut: number; blobs: Blob[]; eligible: Blob[]; solid: Blob[]; ranked: Blob[] } {
  const sigma = Math.max(1, (MASK_BLUR_PX * w) / srcWidth);
  const S = computeSaliency(data, w, h, centerWeight, sigma);
  const cut = Math.max(0, Math.min(1, otsuThreshold(S, w * h, 1024) + threshold));
  let bin: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = S[i] > cut ? 1 : 0;
  bin = morph(morph(bin, w, h, 'max'), w, h, 'min');
  bin = morph(morph(bin, w, h, 'max'), w, h, 'min');
  bin = morph(morph(bin, w, h, 'min'), w, h, 'max');

  const { blobs } = labelBlobs(bin, w, h, S);
  const minArea = MIN_BLOB_FRACTION * w * h;
  const biggest = blobs.reduce((m, b) => Math.max(m, b.area), 0);
  const eligible = blobs.filter((b) => b.area >= minArea || b.area >= biggest * 0.2);
  const solid = eligible.filter(
    (b) => blobFill(b) >= MIN_FILL || b.area < MIN_MASS_FRACTION * w * h,
  );
  const afterFill = solid.length ? solid : eligible;
  const ranked = [...afterFill].sort((a, b) => blobScore(b, w, h) - blobScore(a, w, h));
  return { cut, blobs, eligible, solid: afterFill, ranked: ranked.slice(0, Math.max(1, Math.round(subjects))) };
}

function cover(keptMask: Uint8Array, w: number, box: Box): number {
  let tot = 0, hit = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = y * w + x;
      tot++;
      if (keptMask[i]) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

async function measure(
  key: string,
  centerWeight: number, threshold: number, subjects: number,
): Promise<boolean> {
  const spec = PHOTOS.find((p) => p.key === key);
  if (!spec) {
    console.error(`unknown photo "${key}" — try: ${PHOTOS.map((p) => p.key).join(', ')}`);
    process.exit(2);
  }
  const gt = await import(`./${spec.groundTruth}.ts`) as GroundTruth;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${spec.key.toUpperCase()}   ${spec.file}   (source ${spec.srcWidth}px wide)`);
  console.log(`  centerWeight=${centerWeight}  threshold=${threshold >= 0 ? '+' : ''}${threshold}`
    + `  subjects=${subjects}`);
  console.log('='.repeat(72));

  const { data, w, h } = decodePNGAsRGBA(join(HERE, spec.file));
  const n = w * h;

  const t0 = performance.now();
  const res = buildMask(data, w, h, { centerWeight, threshold, subjects }, spec.srcWidth);
  const ms = performance.now() - t0;

  const d = diagnose(data, w, h, spec.srcWidth, centerWeight, threshold, subjects);

  console.log(`\nmask ${ms.toFixed(0)} ms   Otsu cut = ${res.cut.toFixed(4)}   kept = ${res.kept.length}`);

  const keptIds = new Set(res.kept.map((b) => b.id));
  const rankedIds = new Set(d.ranked.map((b) => b.id));
  const solidIds = new Set(d.solid.map((b) => b.id));

  console.log('\ncandidates:');
  for (const b of [...d.blobs].sort((a, b) => b.area - a.area).slice(0, 12)) {
    const fill = blobFill(b);
    const edge = b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1 || b.y1 === h - 1;
    let why: string;
    if (keptIds.has(b.id)) why = 'KEPT';
    else if (rankedIds.has(b.id)) why = 'out-ranked';
    else if (solidIds.has(b.id)) why = `out-ranked (only ${subjects} wanted)`;
    else if (d.eligible.some((e) => e.id === b.id)) why = `dropped: fill ${fill.toFixed(2)} < ${MIN_FILL}`;
    else why = `dropped: area ${((b.area / n) * 100).toFixed(2)}% too small`;
    console.log(`   ${why.padEnd(38)} area=${String(b.area).padStart(6)} (${((b.area / n) * 100).toFixed(2).padStart(5)}%)`
      + `  fill=${fill.toFixed(3)}  score=${blobScore(b, w, h).toFixed(0).padStart(8)}`
      + `  bbox=[${b.x0},${b.y0}-${b.x1},${b.y1}]  edge=${edge}`);
  }
  if (d.blobs.length > 12) console.log(`   ... and ${d.blobs.length - 12} more`);

  // The kept mask, pixel by pixel.
  const keptMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (res.maskPixels[i * 4]) keptMask[i] = 1;

  // The background the mask must not touch.
  const gtBg = new Uint8Array(n);
  for (const b of gt.BACKGROUND) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) gtBg[y * w + x] = 1;
    }
  }
  let keepN = 0, bgHit = 0;
  for (let i = 0; i < n; i++) {
    if (keptMask[i]) { keepN++; if (gtBg[i]) bgHit++; }
  }
  const contam = keepN ? bgHit / keepN : 0;
  console.log(`\nkept area = ${((keepN / n) * 100).toFixed(2)}% of frame,`
    + ` background contamination = ${(contam * 100).toFixed(1)}%`);

  let found = 0;
  console.log('\nsubjects:');
  for (const s of gt.SUBJECTS) {
    const f = cover(keptMask, w, s);
    const ok = f > gt.COVERAGE_THRESHOLD;
    if (ok) found++;
    console.log(`   ${ok ? 'found  ' : 'MISSED '} ${s.name.padEnd(16)} covered ${(f * 100).toFixed(0)}%`);
  }

  if (gt.OPTIONAL.length) {
    console.log('\noptional (neither subject nor background):');
    for (const s of gt.OPTIONAL) {
      console.log(`   ${s.name.padEnd(16)} covered ${(cover(keptMask, w, s) * 100).toFixed(0)}%`);
    }
  }

  console.log('\nbackground:');
  for (const s of gt.BACKGROUND) {
    console.log(`   ${s.name.padEnd(16)} covered ${(cover(keptMask, w, s) * 100).toFixed(0)}%`);
  }

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
  const out = join(HERE, 'out', `${spec.key}-preview.png`);
  mkdirSync(dirname(out), { recursive: true });
  writePNG(out, w, h, rgb);

  const pass = found === gt.SUBJECTS.length && contam <= gt.CONTAMINATION_CEILING;
  console.log(`\nSUBJECTS FOUND: ${found}/${gt.SUBJECTS.length}`);
  console.log(`wrote ${out}`);
  console.log(pass ? 'PASS' : 'FAIL');
  return pass;
}

// --- run ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const strict = argv.includes('--check');
const rest = argv.filter((a) => a !== '--check');

console.log('shipped constants:',
  `W_RARE=${W_RARE} W_COLOR=${W_COLOR} W_BORDER=${W_BORDER} W_PRIOR=${W_PRIOR}`,
  `TERM_FLOOR=${TERM_FLOOR} MIN_FILL=${MIN_FILL} EDGE_PENALTY=${EDGE_PENALTY}`,
  `MIN_BLOB_FRACTION=${MIN_BLOB_FRACTION} MIN_MASS_FRACTION=${MIN_MASS_FRACTION}`,
  `MASK_BLUR_PX=${MASK_BLUR_PX}`);

const keys = rest[0] && !Number.isFinite(Number(rest[0])) ? [rest[0]] : PHOTOS.map((p) => p.key);
const cw = Number(rest[1] ?? DEFAULTS.centerWeight);
const th = Number(rest[2] ?? DEFAULTS.threshold);
const su = Number(rest[3] ?? DEFAULTS.subjects);

let allPass = true;
for (const k of keys) {
  const ok = await measure(k, cw, th, su);
  if (!ok) allPass = false;
}

// The lab is a measurement rig, not a gate: it reports, and says PASS or
// FAIL. `npm run lab:check` turns a failure into a non-zero exit.
if (strict && !allPass) process.exit(1);
