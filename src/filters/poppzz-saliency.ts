/**
 * The poppzz saliency pipeline — the part that finds the subjects.
 *
 * Pure on purpose: no DOM, no WebGL, no globals. Every function here takes
 * its inputs and returns its outputs, which is what lets `lab/poppzz/`
 * measure the real shipped pipeline instead of a copy of it.
 *
 * The subject is found on a small copy of the frame with classical saliency:
 * colour rarity, colour contrast against the frame and against its edges, and
 * a gentle centre prior. The product is thresholded with Otsu, cleaned up
 * morphologically, split into connected components, and the stray specks are
 * dropped. It is deterministic, needs no model and no dependency, and costs
 * about a tenth of a second — so the mask is built once per image and the
 * sliders stay live at 60fps.
 */

export const MASK_BLUR_PX = 18;     // source pixels — the blur the saliency sees
export const MIN_BLOB_FRACTION = 0.012;  // drop specks below this share of the frame
export const MAX_SCALE = 1.10;       // the pivot map is dilated for the largest scale

// How the four saliency terms share the combination.
//
// These are exponents on a PRODUCT, not weights on a mean — and that is the
// whole trick.
//
// A weighted geometric mean (the weights summing to 1) smooths the map into
// a single hump. Otsu then cuts that hump in half and calls half of the
// photograph a subject: measured on the Ritz photo, the mean gave a cut of
// 0.4706 with 33% of the frame kept and none of the three subjects isolated.
//
// A product keeps the map bimodal — background mass down near zero, subjects
// up at the top — which is the shape Otsu is built to split. The exponents
// sum to 4, the number of terms, so the map keeps a product's shape while
// the ratios say what counts for more: rarity and the centre prior weigh
// more than the two contrast terms.
//
// The floor is what makes the combination forgiving. One term at exactly
// zero would otherwise annihilate the pixel, and a pale grey-blue kurta
// against a stone wall is very nearly zero on the border term. The floor
// lifts every term off zero before it is raised to its power.
export const W_RARE = 1.2, W_COLOR = 0.8, W_BORDER = 0.8, W_PRIOR = 1.2;
export const TERM_FLOOR = 0.05;  // no term may sit at zero before it is powered

// A blob has to be solid to be a subject. A hedge is lacework — it fills
// its bounding box in a scatter, not a shape — and a tree canopy is the
// same. Below this fill ratio a blob is background, whatever its saliency.
//
// The floor is high because the measurements say so. On the Ritz photo a
// subject fills 0.54–0.64 of its box; on the temple photo the bougainvillea
// — a bank of individual blooms, exactly the lacework this rule exists for
// — fills 0.50, and the woman's face fills 0.67.
export const MIN_FILL = 0.55;
// ...but the floor only applies to blobs big enough to be scenery. A small
// scattered blob is a detail of something, not a scene: a face in shadow, a
// hand, a piece of lace. The solidity rule is about hedges and flower banks,
// and those are big; exempting the small ones keeps a distant person from
// being thrown away with the specks.
export const MIN_MASS_FRACTION = 0.05;
// A blob that runs off the edge of the frame is background: it was never a
// whole object in the first place. Its score is halved, not discarded —
// sometimes the subject really does touch the edge.
export const EDGE_PENALTY = 0.5;

/** A connected component of the thresholded mask. */
export interface Blob {
  id: number;
  /** How many pixels it covers. */
  area: number;
  /** Its total saliency — the sum of the saliency map over the blob. */
  sal: number;
  /** Its saliency-weighted centroid, in mask-copy pixels. */
  cx: number;
  cy: number;
  /** Its bounding box, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The parameters the mask itself depends on. */
export interface MaskOptions {
  /** How hard the centre prior pulls. */
  centerWeight: number;
  /** A bias on the Otsu cut, in the saliency map's own units. */
  threshold: number;
  /** How many subjects to keep. */
  subjects: number;
}

/** Everything the mask build produces. */
export interface MaskResult {
  /** The saliency map: the product of the four powered terms. */
  saliency: Float32Array;
  /** The thresholded and morphologically cleaned binary mask. */
  binary: Uint8Array;
  /** The blobs that were kept as subjects. */
  kept: Blob[];
  /**
   * The mask texture, RGBA: R = mask, G/B = pivot (u,v), A = pivot valid.
   */
  maskPixels: Uint8Array;
  /**
   * The debug texture, RGBA: R = saliency, G = thresholded mask, B = kept
   * blobs, A = the outline of the kept ones.
   */
  debugPixels: Uint8Array;
  /** The Otsu cut that was used. */
  cut: number;
}

// --- colour -----------------------------------------------------------------

// sRGB → linear, tabulated once.
const LIN_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// The linear branch of the CIE Lab transfer function: 7.787t + 16/116.
// (The constant is added, not distributed — 7.787t + 0.1379, not (7.787t + 16)/116.)
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/**
 * sRGB → CIE Lab (D65), written into `out`.
 *
 * The caller passes one array in and reads it straight back: allocating a
 * fresh three-element array per pixel was 300k little allocations at 640px,
 * and the garbage they left behind showed up as pauses in the mask build.
 */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array): Float32Array {
  const R = LIN_LUT[r], G = LIN_LUT[g], B = LIN_LUT[b];
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

// --- planes -----------------------------------------------------------------

/**
 * A separable blur on a float plane, as three box passes.
 *
 * A gaussian would do, but its cost grows with the radius and the radius
 * grows with the mask resolution — three gaussian planes came to 150ms at
 * 640px. A box pass is a running sum, so it costs the same whatever the
 * radius, and three of them are close enough to a gaussian for a map that
 * only has to say "distinct" or "not".
 */
export function blurPlane(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round(sigma));
  const inv = 1 / (2 * r + 1);
  const a = Float32Array.from(src);
  const b = new Float32Array(w * h);
  for (let round = 0; round < 3; round++) {
    // horizontal, running sum, edges clamped
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += a[row + (i < 0 ? 0 : i >= w ? w - 1 : i)];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum * inv;
        const out = x - r, inn = x + r + 1;
        sum += (inn < w ? a[row + inn] : a[row + w - 1]) - (out >= 0 ? a[row + out] : a[row]);
      }
    }
    // vertical, same trick
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += b[(i < 0 ? 0 : i >= h ? h - 1 : i) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum * inv;
        const out = y - r, inn = y + r + 1;
        sum += (inn < h ? b[inn * w + x] : b[(h - 1) * w + x]) - (out >= 0 ? b[out * w + x] : b[x]);
      }
    }
  }
  return a;
}

/** Min or max over a full 3×3 box — the structuring element for the morphology. */
export function morph(src: Uint8Array, w: number, h: number, op: 'min' | 'max'): Uint8Array {
  const pick = op === 'max' ? Math.max : Math.min;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          v = pick(v, src[ny * w + nx]);
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Otsu's threshold: the point that splits the histogram with the most
 * between-class variance. Deterministic, and needs no tuning.
 *
 * The bin count matters here. The saliency map is a product, so most of its
 * mass sits near zero; at 256 bins that mass is crushed into the first few
 * and the cut lands on a coarse step. 1024 bins resolve it.
 */
export function otsuThreshold(vals: Float32Array, n: number, bins = 1024): number {
  const hist = new Float64Array(bins);
  const scale = bins - 1;
  for (let i = 0; i < n; i++) {
    let b = Math.round(vals[i] * scale);
    if (b < 0) b = 0;
    else if (b > scale) b = scale;
    hist[b]++;
  }
  let total = 0, sum = 0;
  for (let i = 0; i < bins; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best / scale;
}

/**
 * Connected components (8-connectivity) over the binary mask, each with its
 * area and a saliency-weighted centroid.
 */
export function labelBlobs(
  bin: Uint8Array,
  w: number,
  h: number,
  sal: Float32Array,
): { blobs: Blob[]; labels: Int32Array } {
  const labels = new Int32Array(w * h).fill(-1);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || labels[start] >= 0) continue;
    const id = blobs.length;
    labels[start] = id;
    stack.length = 0;
    stack.push(start);
    let area = 0, s = 0, sx = 0, sy = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % w, y = (p / w) | 0;
      const v = sal[p];
      area++; s += v; sx += x * v; sy += y * v;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (bin[q] && labels[q] < 0) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
    }
    blobs.push({ id, area, sal: s, cx: s ? sx / s : x0, cy: s ? sy / s : y0, x0, y0, x1, y1 });
  }
  return { blobs, labels };
}

/**
 * A plane normalised to 0…1 — every map below is compared against its own
 * extremes, so a photo that is mostly one colour does not skew the rest.
 */
export function normalizePlane(v: Float32Array): Float32Array {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < lo) lo = v[i];
    if (v[i] > hi) hi = v[i];
  }
  const range = hi - lo || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] - lo) / range;
  return out;
}

/**
 * Colour rarity: how unusual this pixel's colour is in the frame. A Lab
 * histogram is built over the whole picture, smoothed, and a pixel scores
 * high when the colours around it are rare — the yellow of a shrine, the
 * red of a sari. Common colours (sky, foliage, pavement) score low.
 *
 * Rarity is what makes the mask a *shape* rather than a set of edges: it
 * holds across the whole interior of a flat-coloured object.
 */
export function colourRarity(
  L: Float32Array,
  A: Float32Array,
  B: Float32Array,
  w: number,
  h: number,
): Float32Array {
  const n = w * h;
  const binL = 16, binA = 16, binB = 16;
  const hist = new Float64Array(binL * binA * binB);
  const at = (i: number) => {
    const l = Math.min(binL - 1, Math.max(0, Math.floor((L[i] / 100) * binL)));
    const a = Math.min(binA - 1, Math.max(0, Math.floor(((A[i] + 100) / 200) * binA)));
    const b = Math.min(binB - 1, Math.max(0, Math.floor(((B[i] + 100) / 200) * binB)));
    return (l * binA + a) * binB + b;
  };
  for (let i = 0; i < n; i++) hist[at(i)]++;
  // Smooth the histogram so a colour that merely straddles a bin boundary
  // does not look rare.
  const sm = new Float64Array(hist.length);
  for (let l = 0; l < binL; l++) {
    for (let a = 0; a < binA; a++) {
      for (let b = 0; b < binB; b++) {
        let sum = 0, count = 0;
        for (let dl = -1; dl <= 1; dl++) {
          for (let da = -1; da <= 1; da++) {
            for (let db = -1; db <= 1; db++) {
              const ll = l + dl, aa = a + da, bb = b + db;
              if (ll < 0 || aa < 0 || bb < 0 || ll >= binL || aa >= binA || bb >= binB) continue;
              sum += hist[(ll * binA + aa) * binB + bb];
              count++;
            }
          }
        }
        sm[(l * binA + a) * binB + b] = sum / count;
      }
    }
  }
  let peak = 0;
  for (const v of sm) if (v > peak) peak = v;
  const rare = new Float32Array(n);
  for (let i = 0; i < n; i++) rare[i] = 1 - sm[at(i)] / (peak || 1);
  return normalizePlane(rare);
}

/**
 * x^e for x in 0…1, tabulated. The table is 1024 wide, so the largest error
 * is a fraction of a percent of the value — well under a pixel's worth of
 * saliency.
 */
export function powLUT(e: number, size = 1024): Float32Array {
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i++) lut[i] = Math.pow(i / (size - 1), e);
  return lut;
}

export function lutLookup(lut: Float32Array, v: number): number {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  return lut[(x * (lut.length - 1) + 0.5) | 0];
}

/**
 * The saliency map: rarity, colour contrast, border contrast and the centre
 * prior, combined as a product of powers.
 *
 * The three distinctness terms all measure the same idea from different
 * angles — a subject is a colour that is rare in the frame, unlike the
 * frame's average colour, and unlike the colours along the edges. Taken
 * together they are what kills the foliage and the pavement: both are
 * common, and both sit close to the background.
 *
 * A gradient/detail term was tried here first and dropped: detail only fires
 * on edges, so the mask came out as fragments of outlines instead of whole
 * subjects.
 */
export function computeSaliency(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerWeight: number,
  sigma: number,
): Float32Array {
  const n = w * h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const lab = new Float32Array(3);
  let mL = 0, mA = 0, mB = 0;
  for (let i = 0; i < n; i++) {
    rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    mL += lab[0]; mA += lab[1]; mB += lab[2];
  }
  mL /= n; mA /= n; mB /= n;

  // Colour contrast: the distance between a lightly blurred pixel and the
  // frame's mean Lab. The blur is measured in *source* pixels, so the map
  // comes out the same whether the mask copy is 256px or 640px — in texels
  // alone it would be a much tighter blur at the higher resolution, and the
  // subject's own texture would cut it into pieces.
  const Lb = blurPlane(L, w, h, sigma);
  const Ab = blurPlane(A, w, h, sigma);
  const Bb = blurPlane(B, w, h, sigma);
  const colorRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dL = Lb[i] - mL, dA = Ab[i] - mA, dB = Bb[i] - mB;
    colorRaw[i] = Math.sqrt(dL * dL + dA * dA + dB * dB);
  }
  const color = normalizePlane(colorRaw);

  // Border contrast: the same distance, but against the colours along the
  // edge of the frame. The edge is where the background usually is, so this
  // separates a subject from its surroundings even when the whole frame
  // shares one colour.
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.07));
  let bL = 0, bA = 0, bB = 0, bn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
      const i = y * w + x;
      bL += L[i]; bA += A[i]; bB += B[i]; bn++;
    }
  }
  bL /= bn; bA /= bn; bB /= bn;
  const borderRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dL = Lb[i] - bL, dA = Ab[i] - bA, dB = Bb[i] - bB;
    borderRaw[i] = Math.sqrt(dL * dL + dA * dA + dB * dB);
  }
  const border = normalizePlane(borderRaw);

  const rare = colourRarity(L, A, B, w, h);

  // Centre prior: a wide gaussian, so border clutter does not win outright.
  const cx = w / 2, cy = h / 2, cSigma = 0.5 * Math.max(w, h);

  // The four terms, each raised to its power, multiplied together.
  //
  // The powers are tabulated: four Math.pow calls per pixel is 1.2 million
  // calls at 640px, and this runs on every mask rebuild.
  const lutR = powLUT(W_RARE), lutC = powLUT(W_COLOR);
  const lutB = powLUT(W_BORDER), lutP = powLUT(W_PRIOR);
  const S = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x - cx, dy = y - cy;
      const center = Math.exp(-(dx * dx + dy * dy) / (2 * cSigma * cSigma));
      const prior = (1 - centerWeight) + centerWeight * center;
      S[i] = lutLookup(lutR, rare[i] + TERM_FLOOR)
           * lutLookup(lutC, color[i] + TERM_FLOOR)
           * lutLookup(lutB, border[i] + TERM_FLOOR)
           * lutLookup(lutP, prior);
    }
  }
  return S;
}

// --- choosing the subjects --------------------------------------------------

/**
 * How good a candidate subject a blob is.
 *
 * Ranking by total saliency is what let the hedges and trees win: they are
 * big, so their saliency adds up, even though each part of them is only
 * moderately salient. Two things cut against that — how solid the blob is
 * (a hedge is a lacework, a subject is a shape), and whether it runs off the
 * edge of the frame (a blob that does was never a whole object).
 *
 * The solidity test is a filter rather than a score, though. Multiplying the
 * score by the fill ratio was tried and it demotes a big, real subject — the
 * sari in the foreground of the Ritz photo — below a small solid one: the
 * fill ratio says how much of the bounding box the blob fills, and a person
 * fills less of theirs than a bench does.
 */
export function blobFill(b: Blob): number {
  return b.area / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
}

export function blobScore(b: Blob, w: number, h: number): number {
  const edge = b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1 || b.y1 === h - 1 ? EDGE_PENALTY : 1;
  return b.sal * edge;
}

// --- the whole pipeline -----------------------------------------------------

/**
 * Build the mask from a downscaled copy of the frame.
 *
 * `data` is the copy's RGBA pixels, `w`/`h` its size, and `srcWidth` the
 * width of the *source* image — the saliency's blur is measured in source
 * pixels, so it means the same thing whatever size the copy is.
 */
export function buildMask(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: MaskOptions,
  srcWidth: number,
): MaskResult {
  // The saliency's blur is measured in source pixels, so it means the same
  // thing whatever size the mask copy is.
  const sigma = Math.max(1, (MASK_BLUR_PX * w) / srcWidth);
  const S = computeSaliency(data, w, h, opts.centerWeight, sigma);

  // Otsu, with the bias slider nudging the cut.
  //
  // The cut lands in the map's own units. The map is a product, so its mass
  // is piled up near zero with the subjects standing clear above it — that
  // is the shape Otsu splits. A root before the threshold would pull the
  // near-zero background mass UP towards the subjects and destroy the
  // separation: measured, Math.pow(S, 0.25) moved the cut to 0.4627 and
  // turned the whole photograph into one blob. What the crowded histogram
  // needed was more bins, not a different scale: 1024 bins resolve the low
  // end that 256 bins crush into their first few.
  const cut = Math.max(0, Math.min(1, otsuThreshold(S, w * h, 1024) + opts.threshold));
  let bin: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = S[i] > cut ? 1 : 0;
  // Close (dilate then erode), then open (erode then dilate): fills holes and
  // clears the ragged edge the threshold leaves behind. The close runs twice
  // so that parts of a subject separated by a few pixels join up.
  bin = morph(morph(bin, w, h, 'max'), w, h, 'min');
  bin = morph(morph(bin, w, h, 'max'), w, h, 'min');
  bin = morph(morph(bin, w, h, 'min'), w, h, 'max');

  const { blobs, labels } = labelBlobs(bin, w, h, S);
  // Drop the specks — the birds, the bright buttons. A blob must clear the
  // frame-share floor, and also stay in proportion to the biggest subject so
  // a second, smaller subject is not thrown away with the specks.
  //
  // The floor is low enough to keep a face: on the temple photo the woman's
  // face is 1.42% of the frame, and at a 1.5% floor it was dropped as a
  // speck before it was ever ranked against the rest.
  const minArea = MIN_BLOB_FRACTION * w * h;
  const biggest = blobs.reduce((m, b) => Math.max(m, b.area), 0);
  let eligible = blobs.filter((b) => b.area >= minArea || b.area >= biggest * 0.2);
  // ...and drop the lacework. A hedge or a tree canopy fills its bounding
  // box in a scatter rather than a shape; a subject is solid. The rule only
  // reaches blobs big enough to be scenery — see MIN_MASS_FRACTION. If it
  // leaves nothing at all, the photo has no solid subject and the unfiltered
  // set is better than an empty mask.
  const solid = eligible.filter(
    (b) => blobFill(b) >= MIN_FILL || b.area < MIN_MASS_FRACTION * w * h,
  );
  if (solid.length) eligible = solid;
  const kept = eligible
    .sort((a, b) => blobScore(b, w, h) - blobScore(a, w, h))
    .slice(0, Math.max(1, Math.round(opts.subjects)));

  // The mask texture: R is the mask itself, G/B carry each blob's pivot and
  // A says whether a pivot is valid.
  const px = new Uint8Array(w * h * 4);
  for (const b of kept) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * w + x;
        if (labels[i] === b.id) px[i * 4] = 255;
      }
    }
  }
  // The pivot map: for every pixel of the subject's footprint, the centre of
  // the blob it belongs to. Inverse warp the footprint back onto the mask to
  // find out which blob it is.
  //
  // The warp has to be done at more than one scale. At the largest scale
  // alone, a pixel of a concave subject — under the lady's outstretched arm,
  // between the cenotaph's spires — warps outside the blob and never gets a
  // pivot, so it drops back to the dimmed background and the subject comes
  // out with a hole in it. Warping at 1 stamps the subject's own pixels, and
  // the steps in between fill the gap up to the largest scale.
  for (const b of kept) {
    const pu = Math.round((b.cx / w) * 255);
    const pv = Math.round((b.cy / h) * 255);
    for (const s of [1, 1 + (MAX_SCALE - 1) / 2, MAX_SCALE]) {
      // The footprint at scale s is the blob's box grown about its centre.
      const ox0 = Math.max(0, Math.floor(b.cx - (b.cx - b.x0) * s));
      const ox1 = Math.min(w - 1, Math.ceil(b.cx + (b.x1 - b.cx) * s));
      const oy0 = Math.max(0, Math.floor(b.cy - (b.cy - b.y0) * s));
      const oy1 = Math.min(h - 1, Math.ceil(b.cy + (b.y1 - b.cy) * s));
      for (let y = oy0; y <= oy1; y++) {
        for (let x = ox0; x <= ox1; x++) {
          const i = y * w + x;
          if (px[i * 4 + 3]) continue;        // already has a pivot
          const sx = b.cx + (x - b.cx) / s;
          const sy = b.cy + (y - b.cy) / s;
          const ix = Math.round(sx), iy = Math.round(sy);
          if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
          if (labels[iy * w + ix] !== b.id) continue;
          px[i * 4 + 1] = pu;
          px[i * 4 + 2] = pv;
          px[i * 4 + 3] = 255;   // this pixel has a pivot
        }
      }
    }
  }

  // The debug texture: R is the saliency map as Otsu sees it, G every blob that
  // came out of the threshold, B the blobs that were kept, A the outline of
  // the kept ones. It is built here, while the numbers are to hand.
  const dbg = new Uint8Array(w * h * 4);
  let salMax = 0;
  for (let i = 0; i < w * h; i++) if (S[i] > salMax) salMax = S[i];
  for (let i = 0; i < w * h; i++) {
    dbg[i * 4] = salMax ? Math.round((S[i] / salMax) * 255) : 0;
    dbg[i * 4 + 1] = bin[i] ? 255 : 0;
  }
  for (const b of kept) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * w + x;
        if (labels[i] === b.id) dbg[i * 4 + 2] = 255;
      }
    }
  }
  // The outline is the kept mask minus its own erosion.
  const keptMask = new Uint8Array(w * h);
  for (const b of kept) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * w + x;
        if (labels[i] === b.id) keptMask[i] = 1;
      }
    }
  }
  const inner = morph(keptMask, w, h, 'min');
  for (let i = 0; i < w * h; i++) if (keptMask[i] && !inner[i]) dbg[i * 4 + 3] = 255;

  return { saliency: S, binary: bin, kept, maskPixels: px, debugPixels: dbg, cut };
}
