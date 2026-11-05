/**
 * Sweep poppzz's knobs and constants against every photograph's ground
 * truth, and print one line per combination.
 *
 *   node lab/poppzz/sweep.ts knobs    # the sliders the app exposes
 *   node lab/poppzz/sweep.ts consts   # the constants inside the pipeline
 *
 * The selection is replicated here — the same way `diagnose` in verify.ts
 * does it — so the constants under test can be varied. They are module-level
 * constants in the shipped pipeline and cannot be passed in.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EDGE_PENALTY, MASK_BLUR_PX, MIN_BLOB_FRACTION, MIN_FILL,
  blobFill, computeSaliency, labelBlobs, morph, otsuThreshold,
} from '../../src/filters/poppzz-saliency.ts';
import type { Blob } from '../../src/filters/poppzz-saliency.ts';
import type { Box } from './ground-truth.ts';
import { decodePNGAsRGBA } from './png.ts';
import { PHOTOS } from './photos.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface GroundTruth {
  SUBJECTS: Box[];
  BACKGROUND: Box[];
  OPTIONAL: Box[];
  COVERAGE_THRESHOLD: number;
  CONTAMINATION_CEILING: number;
}

interface Params {
  centerWeight: number;
  threshold: number;
  subjects: number;
  minBlobFraction: number;
  minFill: number;
  edgePenalty: number;
}

const BASE: Params = {
  centerWeight: 0.4, threshold: 0, subjects: 3,
  minBlobFraction: MIN_BLOB_FRACTION, minFill: MIN_FILL, edgePenalty: EDGE_PENALTY,
};

async function load(key: string) {
  const spec = PHOTOS.find((p) => p.key === key)!;
  const gt = await import(`./${spec.groundTruth}.ts`) as GroundTruth;
  return { spec, gt };
}

function run(
  spec: typeof PHOTOS[number], gt: GroundTruth, p: Params,
) {
  const { data, w, h } = decodePNGAsRGBA(join(HERE, spec.file));
  const n = w * h;
  const sigma = Math.max(1, (MASK_BLUR_PX * w) / spec.srcWidth);
  const S = computeSaliency(data, w, h, p.centerWeight, sigma);
  const cut = Math.max(0, Math.min(1, otsuThreshold(S, n, 1024) + p.threshold));
  let bin: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = S[i] > cut ? 1 : 0;
  bin = morph(morph(bin, w, h, 'max'), w, h, 'min');
  bin = morph(morph(bin, w, h, 'max'), w, h, 'min');
  bin = morph(morph(bin, w, h, 'min'), w, h, 'max');

  const { blobs, labels } = labelBlobs(bin, w, h, S);
  const minArea = p.minBlobFraction * n;
  const biggest = blobs.reduce((m, b) => Math.max(m, b.area), 0);
  let eligible = blobs.filter((b) => b.area >= minArea || b.area >= biggest * 0.2);
  const solid = eligible.filter((b) => blobFill(b) >= p.minFill);
  if (solid.length) eligible = solid;
  const score = (b: Blob) => {
    const edge = b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1 || b.y1 === h - 1 ? p.edgePenalty : 1;
    return b.sal * edge;
  };
  const kept = [...eligible].sort((a, b) => score(b) - score(a))
    .slice(0, Math.max(1, Math.round(p.subjects)));

  const mask = new Uint8Array(n);
  for (const b of kept) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * w + x;
        if (labels[i] === b.id) mask[i] = 1;
      }
    }
  }
  const bg = new Uint8Array(n);
  for (const b of gt.BACKGROUND) {
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) bg[y * w + x] = 1;
  }
  let keepN = 0, bgHit = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { keepN++; if (bg[i]) bgHit++; }

  const cov = (box: Box) => {
    let tot = 0, hit = 0;
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) { tot++; if (mask[y * w + x]) hit++; }
    }
    return tot ? hit / tot : 0;
  };
  const subjects = gt.SUBJECTS.map((s) => ({ name: s.name, f: cov(s) }));
  return {
    found: subjects.filter((s) => s.f > gt.COVERAGE_THRESHOLD).length,
    total: gt.SUBJECTS.length,
    contam: keepN ? bgHit / keepN : 0,
    area: keepN / n,
    subjects,
    pass: subjects.filter((s) => s.f > gt.COVERAGE_THRESHOLD).length === gt.SUBJECTS.length
      && (keepN ? bgHit / keepN : 0) <= gt.CONTAMINATION_CEILING,
  };
}

const loaded = await Promise.all(PHOTOS.map((p) => load(p.key)));

function show(tag: string, p: Params) {
  const rows = loaded.map(({ spec, gt }) => {
    const r = run(spec, gt, p);
    const f = `${r.found}/${r.total} cont ${(r.contam * 100).toFixed(0).padStart(3)}%`
      + ` area ${(r.area * 100).toFixed(1).padStart(5)}%  [`
      + r.subjects.map((s) => `${s.name.split(' ')[0]} ${(s.f * 100).toFixed(0)}%`).join(', ') + ']';
    return { key: spec.key, f, pass: r.pass };
  });
  console.log(tag.padEnd(26) + rows.map((r) => `${r.key}: ${r.f} ${r.pass ? 'PASS' : 'fail'}`).join('   '));
}

console.log('shipped constants:',
  `MIN_BLOB_FRACTION=${MIN_BLOB_FRACTION} MIN_FILL=${MIN_FILL} EDGE_PENALTY=${EDGE_PENALTY}`
  + ` MASK_BLUR_PX=${MASK_BLUR_PX}`);
console.log('');
show('shipped defaults', { ...BASE });

const which = process.argv[2] ?? 'all';

if (which === 'all' || which === 'knobs') {
  console.log('\n== centre weight ==');
  for (const cw of [0.2, 0.4, 0.6, 0.8, 1.0]) show(`centerWeight=${cw}`, { ...BASE, centerWeight: cw });

  console.log('\n== subjects ==');
  for (const s of [3, 4, 5, 6]) show(`subjects=${s}`, { ...BASE, subjects: s });

  console.log('\n== threshold ==');
  for (const t of [-0.06, -0.03, 0, 0.03, 0.06]) show(`threshold=${t}`, { ...BASE, threshold: t });
}

if (which === 'all' || which === 'consts') {
  console.log('\n== MIN_BLOB_FRACTION ==');
  for (const m of [0.015, 0.012, 0.01, 0.008, 0.005]) show(`minBlobFraction=${m}`, { ...BASE, minBlobFraction: m });

  console.log('\n== MIN_FILL ==');
  for (const m of [0.2, 0.3, 0.4, 0.5]) show(`minFill=${m}`, { ...BASE, minFill: m });

  console.log('\n== EDGE_PENALTY ==');
  for (const e of [0.25, 0.5, 0.75, 1.0]) show(`edgePenalty=${e}`, { ...BASE, edgePenalty: e });
}
