/**
 * poppzz: find the main objects in a picture and make them look like they
 * are standing in front of it.
 *
 * This half of the filter owns the GPU side — the shaders, the mask textures
 * and the composite. The half that actually finds the subjects lives in
 * `poppzz-saliency.ts`, which is pure and has no idea the GPU exists.
 */
import { bindTex, deleteTarget, gl, makeProgram, makeTarget, pass, progBlur, progCopy, SPREAD } from '../gl.js';
import { state } from '../state.js';
import { buildMask } from './poppzz-saliency.js';
import type { FilterDef, ParamValues, Target } from '../types.js';

const MASK_MIN_EDGE = 256;   // saliency does not need less than this
const MASK_MAX_EDGE = 640;   // ...nor more: the mask is upsampled by the GPU
const MASK_MIN_SIGMA = 1.2;  // texels — the anti-alias floor on the edge

// Poppzz composite: the masked subject is magnified about its own centroid
// and laid over the untouched original, while the background is dimmed and
// desaturated. The mask is sampled at the *scaled* coordinate, so it grows
// with the object; the pivot map (dilated to the largest scale the slider
// allows) says which blob owns this pixel and where its centre is.
//
// The pivot map is sampled with linear filtering, so at a blob's edge the
// pivot channels and the validity flag are both ramped down towards zero —
// the pivot drifts towards (0,0) exactly where the silhouette is. They ramp
// together, so dividing one by the other puts the pivot back where it was.
const FRAG_POP = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform sampler2D uImg;
uniform sampler2D uMask;
uniform sampler2D uPivot;
uniform float uScale;
uniform float uDim;
uniform float uDesat;
uniform float uShadow;
uniform vec2 uShadowOffset;
void main() {
  vec2 uv = vUV;
  vec4 pv = texture2D(uPivot, uv);
  vec2 pivot = pv.gb / max(pv.a, 1e-3);   // undo the edge interpolation
  vec2 fgUV = pivot + (uv - pivot) / uScale;
  float a = texture2D(uMask, fgUV).r * pv.a;
  vec3 fg = texture2D(uImg, fgUV).rgb;
  vec3 bg = texture2D(uImg, uv).rgb;
  float lum = dot(bg, vec3(0.299, 0.587, 0.114));
  bg = mix(bg, vec3(lum), uDesat);
  bg *= (1.0 - uDim);
  // The background is dimmed everywhere, including under the subject — and
  // the enlarged subject's feathered edge then blends against a dimmed copy
  // of the subject's own edge pixels, which reads as a dark ring inside the
  // silhouette. Put the original pixels back under the unscaled mask.
  float a0 = texture2D(uMask, uv).r;
  bg = mix(bg, texture2D(uImg, uv).rgb, a0);
  // The shadow is the blurred mask, nudged off the subject and darkened.
  float sh = texture2D(uMask, uv + uShadowOffset).r;
  bg *= (1.0 - uShadow * sh * 0.55);
  gl_FragColor = vec4(mix(bg, fg, smoothstep(0.0, 1.0, a)), 1.0);
}`;

// The debug view: what the saliency pipeline is actually doing. The grey is
// the saliency map, red is everything that came out of the threshold, green
// the blobs that were kept as subjects, and blue their outlines.
const FRAG_DEBUG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform sampler2D uDbg;
void main() {
  vec4 d = texture2D(uDbg, vUV);
  vec3 c = vec3(d.r);
  c = mix(c, vec3(1.0, 0.30, 0.25), d.g * 0.45);
  c = mix(c, vec3(0.35, 1.0, 0.45), d.b * 0.45);
  c = mix(c, vec3(0.45, 0.80, 1.0), d.a * 0.9);
  gl_FragColor = vec4(c, 1.0);
}`;

const progPop = makeProgram(FRAG_POP);
const progDbg = makeProgram(FRAG_DEBUG);

interface MaskTargets {
  tex: Target;   // R = mask, G/B = pivot (u,v), A = pivot valid
  out: Target;   // the blurred mask — the feathered boundary
  tmp: Target;   // scratch for the blur
  dbg: Target;   // R = saliency, G = mask, B = kept, A = outline
}

let maskTargets: MaskTargets | null = null;
let maskSrc: { data: Uint8ClampedArray; w: number; h: number } | null = null;
let maskReady = false;
let maskTimer = 0;
let maskMs = 0;          // how long the saliency pipeline took
let maskVersion = 0;     // bumped on every rebuild; the blur cache keys on it
let maskBlurred = -1;    // the version the blurred mask was made from
let maskFeather = -1;    // ...and the feather it was made with

/**
 * Called after the mask is rebuilt, so the stage can be redrawn. The app
 * shell owns the render loop and registers itself here.
 */
let onRebuilt: (() => void) | null = null;

export function onMaskRebuilt(fn: () => void): void {
  onRebuilt = fn;
}

function allocMaskTargets(w: number, h: number): void {
  if (maskTargets) {
    for (const t of Object.values(maskTargets)) deleteTarget(t);
  }
  maskTargets = {
    tex: makeTarget(w, h),
    out: makeTarget(w, h),
    tmp: makeTarget(w, h),
    dbg: makeTarget(w, h),
  };
}

/**
 * The downscaled copy the saliency pipeline works on. The copy is sized to
 * the picture: a third of the long edge, clamped. Saliency does not need full
 * resolution, but the mask *is* the silhouette the user sees, and a mask
 * scaled up from 256px shows its texels as facets along the edge.
 */
export function prepareMaskSource(src: TexImageSource, w: number, h: number): void {
  const long = Math.max(w, h);
  const edge = Math.min(MASK_MAX_EDGE, Math.max(MASK_MIN_EDGE, Math.round(long / 3)));
  const s = edge / long;
  const mw = Math.max(8, Math.round(w * s)), mh = Math.max(8, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = mw;
  c.height = mh;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!x) return;
  x.drawImage(src as CanvasImageSource, 0, 0, mw, mh);
  maskSrc = { data: x.getImageData(0, 0, mw, mh).data, w: mw, h: mh };
  allocMaskTargets(mw, mh);
  maskReady = false;
  // The mask is only worth building for the filter that uses it.
  if (state.currentFilter === 'poppzz') rebuildMask();
}

/** Build the mask if it is not there yet — a Bloom session never pays for it. */
export function ensureMask(): void {
  if (maskSrc && !maskReady) rebuildMask();
}

/** A mask slider moved: rebuild once the user stops dragging. */
export function scheduleMaskRebuild(): void {
  clearTimeout(maskTimer);
  maskTimer = setTimeout(() => {
    rebuildMask();
    onRebuilt?.();
  }, 200);
}

function rebuildMask(): void {
  if (!maskSrc || !maskTargets) return;
  const t0 = performance.now();
  const cfg = state.params.poppzz ?? {};
  const res = buildMask(
    maskSrc.data,
    maskSrc.w,
    maskSrc.h,
    {
      centerWeight: cfg.centerWeight ?? 0.4,
      threshold: cfg.threshold ?? 0,
      subjects: cfg.subjects ?? 3,
    },
    state.imgW,
  );
  const { w, h } = maskSrc;
  gl.bindTexture(gl.TEXTURE_2D, maskTargets.tex.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, res.maskPixels);
  gl.bindTexture(gl.TEXTURE_2D, maskTargets.dbg.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, res.debugPixels);
  maskReady = true;
  maskVersion++;
  maskMs = performance.now() - t0;
}

/**
 * The mask's own blur — the feather on the boundary. Radius is given in image
 * pixels, so it is converted into the mask texture's own texels. The blur
 * also has a floor: the mask is a binary image, and without a texel or two
 * of blur its edges show the texel grid as facets when the GPU scales it up.
 */
function blurMask(featherPx: number): void {
  // Cached: the blur only changes when the mask is rebuilt or the feather
  // moves, and it was being redone on every single frame.
  const src = maskSrc, targets = maskTargets;
  if (!src || !targets) return;
  if (maskBlurred === maskVersion && maskFeather === featherPx) return;
  const rds = Math.max(MASK_MIN_SIGMA / SPREAD, (featherPx * src.w) / state.imgW);
  const st = SPREAD * 32;
  pass(progBlur, targets.tmp, src.w, src.h, (L) => {
    gl.uniform1f(L('uFlipY'), 0);
    gl.uniform2f(L('uTexel'), 1 / src.w, 1 / src.h);
    gl.uniform2f(L('uDir'), 1, 0);
    gl.uniform1f(L('uRadiusPx'), rds);
    gl.uniform1f(L('uSigmaTaps'), st);
    bindTex(0, targets.tex.tex);
  });
  pass(progBlur, targets.out, src.w, src.h, (L) => {
    gl.uniform1f(L('uFlipY'), 0);
    gl.uniform2f(L('uTexel'), 1 / src.w, 1 / src.h);
    gl.uniform2f(L('uDir'), 0, 1);
    gl.uniform1f(L('uRadiusPx'), rds);
    gl.uniform1f(L('uSigmaTaps'), st);
    bindTex(0, targets.tmp.tex);
  });
  maskBlurred = maskVersion;
  maskFeather = featherPx;
}

/** Drop the mask and its textures — the image is going away. */
export function releasePoppzz(): void {
  if (maskTargets) {
    for (const t of Object.values(maskTargets)) deleteTarget(t);
  }
  maskTargets = null;
  maskSrc = null;
  maskReady = false;
  maskVersion++;
  maskBlurred = -1;
  maskFeather = -1;
}

export function describePoppzz(): string {
  return `mask ${maskMs.toFixed(0)} ms`;
}

export function renderPoppzz(src: WebGLTexture, dst: Target | null, p: ParamValues): void {
  // The mask is built the first time poppzz actually renders, so a session
  // that never touches the filter never pays for it.
  if (!maskReady) ensureMask();
  const targets = maskTargets;
  if (!maskReady || !targets) {
    // Still no mask — show the source untouched.
    pass(progCopy, dst, state.imgW, state.imgH, (L) => {
      gl.uniform1f(L('uFlipY'), dst ? 0 : 1);
      bindTex(0, src);
    });
    return;
  }
  // The debug view replaces the composite entirely: the saliency map, the
  // binary mask and the blob outlines, so the pipeline can be seen rather
  // than guessed at.
  if (p.debug) {
    pass(progDbg, dst, state.imgW, state.imgH, (L) => {
      gl.uniform1f(L('uFlipY'), dst ? 0 : 1);
      gl.uniform1i(L('uDbg'), 0);
      bindTex(0, targets.dbg.tex);
    });
    return;
  }
  blurMask(p.feather);
  const bgDim = p.bgFx ? p.bgDim : 0;
  const bgDesat = p.bgFx ? p.bgDesat : 0;
  pass(progPop, dst, state.imgW, state.imgH, (L) => {
    gl.uniform1f(L('uFlipY'), dst ? 0 : 1);
    gl.uniform1f(L('uScale'), p.scale);
    gl.uniform1f(L('uDim'), bgDim);
    gl.uniform1f(L('uDesat'), bgDesat);
    gl.uniform1f(L('uShadow'), p.shadow);
    gl.uniform2f(L('uShadowOffset'), 4 / state.imgW, 4 / state.imgH);
    gl.uniform1i(L('uImg'), 0);
    gl.uniform1i(L('uMask'), 1);
    gl.uniform1i(L('uPivot'), 2);
    bindTex(0, src);
    bindTex(1, targets.out.tex);
    bindTex(2, targets.tex.tex);
  });
}

export const poppzzDef: FilterDef = {
  name: 'poppzz',
  kind: 'poppzz',
  // The subject is found by classical saliency — colour rarity, colour
  // contrast against the frame and against its edges, a gentle centre
  // prior — thresholded with Otsu and cleaned up morphologically.
  // Deterministic, no model, a few tens of milliseconds on a 256px copy, so
  // the mask is built once per image and the sliders below stay live.
  //
  // `mask: true` marks the sliders that change the mask itself (rather than
  // the composite); those trigger a rebuild instead of a redraw.
  defaults: {
    scale: 1.03, feather: 12, bgDim: 0.18, bgDesat: 0.12, shadow: 0.35, bgFx: 1,
    threshold: 0, centerWeight: 0.4, subjects: 3, debug: 0,
  },
  params: [
    { key: 'scale', min: 1, max: 1.1, step: 0.005, fmt: (v) => `${v.toFixed(3)}×` },
    { key: 'feather', min: 0, max: 40, step: 1, fmt: (v) => `${Math.round(v)} px` },
    { key: 'bgDim', min: 0, max: 0.6, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'bgDesat', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'shadow', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'bgFx', type: 'bool', min: 0, max: 1, step: 1, fmt: (v) => (v ? 'on' : 'off') },
    { key: 'subjects', min: 1, max: 5, step: 1, mask: true, fmt: (v) => `${Math.round(v)}` },
    // The cut lives in the saliency map's own units. Otsu lands at about
    // 0.20 on a typical frame, so this nudges the cut around that point:
    // −0.06 admits a lot more background, +0.06 trims the subjects back.
    // Measured on the Ritz photo the whole ±0.06 range keeps all three
    // subjects and moves the kept area between 13% and 4% of the frame.
    { key: 'threshold', min: -0.06, max: 0.06, step: 0.005, mask: true,
      fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(3) },
    { key: 'centerWeight', min: 0, max: 1, step: 0.01, mask: true, fmt: (v) => v.toFixed(2) },
    { key: 'debug', type: 'bool', min: 0, max: 1, step: 1, fmt: (v) => (v ? 'on' : 'off') },
  ],
  paramChanged(key) {
    const spec = poppzzDef.params.find((p) => p.key === key);
    if (spec?.mask) scheduleMaskRebuild();
  },
  prepareSource(src, w, h) {
    prepareMaskSource(src, w, h);
  },
  ensureReady() {
    ensureMask();
  },
  clearSource() {
    // The mask belongs to the image, not to the filter being active — it
    // survives a switch to Bloom and a switch back, so poppzz is instant
    // the second time. Only the image going away discards it.
    releasePoppzz();
  },
  describe() {
    return describePoppzz();
  },
  render(src, dst, p) {
    renderPoppzz(src, dst, p);
  },
};
