/**
 * Bloom: a thresholded highlight bloom over a downsampled separable gaussian,
 * composited under a sharp layer.
 *
 * The filter owns its own shaders, its own working targets and its own
 * parameter surface. Nothing else in the app has to know what Bloom is.
 */
import { bindTex, deleteTarget, gl, makeProgram, makeTarget, pass, progBlur, SPREAD } from '../gl.js';
import { state } from '../state.js';
import type { FilterDef, ParamValues, Target } from '../types.js';

// Copy/prefilter pass: plain copy when uThresh < 0, else per-channel soft knee
// max(c - t, 0). Run at the target's own size — with mipmapped sources the
// auto LOD gives an area downsample instead of a point sample.
const FRAG_PRE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uThresh;
void main() {
  vec4 c = texture2D(uTex, vUV);
  gl_FragColor = uThresh < 0.0 ? c : vec4(max(c.rgb - vec3(uThresh), vec3(0.0)), c.a);
}`;

// Composite at full res: sharp layer at sharpAmt over the bilinear-upscaled
// soft layer, plus thresholded bloom × boost. The "upscale" is just LINEAR
// filtering on the small textures.
const FRAG_COMP = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uSoft;
uniform sampler2D uBloom;
uniform float uSharp;
uniform float uBoost;
uniform float uOn;
void main() {
  vec4 sharp = texture2D(uTex, vUV);
  if (uOn < 0.5) { gl_FragColor = sharp; return; }
  vec4 outc = texture2D(uSoft, vUV) * (1.0 - uSharp) + sharp * uSharp;
  outc.rgb += texture2D(uBloom, vUV).rgb * uBoost;
  gl_FragColor = outc;
}`;

const progPre = makeProgram(FRAG_PRE);
const progComp = makeProgram(FRAG_COMP);

interface BloomTargets {
  thr: Target;
  soft: Target;
  bloom: Target;
  tmp: Target;
}

let T: BloomTargets | null = null;
let dsFactor = 0;
let dsW = 0, dsH = 0;

// Blur downsample factor, derived per render: smallest power of two that keeps
// the blur radius ≤ ~24px at downsampled res, so tap spacing stays ≤ ~1px and
// sparse-kernel ghosting can never appear — 1/2 for small radii, up to 1/16.
// The radius is in source pixels, so it is compared against 24 directly.
function DS(radius: number): number {
  return Math.min(16, Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(1, radius) / 24))));
}

/**
 * Bloom's working targets are big — `thr` alone is a full-resolution buffer,
 * about 64 MB on a 4608×3456 frame. Poppzz never touches them, so they are
 * only allocated while Bloom is the selected filter, and released the moment
 * another filter takes over.
 */
export function releaseBloom(): void {
  if (T) {
    for (const k of Object.keys(T) as (keyof BloomTargets)[]) deleteTarget(T[k]);
  }
  T = null;
  dsFactor = 0;
}

function allocTargets(radius: number): void {
  releaseBloom();
  if (!state.imgW) return;
  dsFactor = DS(radius);
  dsW = Math.max(1, Math.round(state.imgW / dsFactor));
  dsH = Math.max(1, Math.round(state.imgH / dsFactor));
  T = {
    thr: makeTarget(state.imgW, state.imgH),
    soft: makeTarget(dsW, dsH),
    bloom: makeTarget(dsW, dsH),
    tmp: makeTarget(dsW, dsH),
  };
}

/** Allocate the working targets if the radius or the image size changed. */
export function prepareBloom(radius: number): void {
  const f = DS(radius);
  if (f === dsFactor && T) return;
  allocTargets(radius);
}

export function describeBloom(): string {
  return `blur@1/${dsFactor}`;
}

/**
 * Run Bloom over `src` and write the result to `dst` (null = screen). The
 * pass order is unchanged: threshold at full res so speculars of any size
 * survive the downsample, copy the source for the soft layer, blur both,
 * composite.
 */
export function renderBloom(src: WebGLTexture, dst: Target | null, p: ParamValues): void {
  const t = T;
  if (!t) return;
  pass(progPre, t.thr, state.imgW, state.imgH, (L) => {
    gl.uniform1f(L('uFlipY'), 0);
    gl.uniform1f(L('uThresh'), p.thresh);
    bindTex(0, src);
  });
  // T.thr downsamples with plain bilinear — it is about to be blurred anyway,
  // so a per-frame mip chain here is pure cost (~20ms measured).
  pass(progPre, t.soft, dsW, dsH, (L) => {
    gl.uniform1f(L('uFlipY'), 0);
    gl.uniform1f(L('uThresh'), -1);
    bindTex(0, src);
  });
  pass(progPre, t.bloom, dsW, dsH, (L) => {
    gl.uniform1f(L('uFlipY'), 0);
    gl.uniform1f(L('uThresh'), -1);
    bindTex(0, t.thr.tex);
  });
  const rds = p.radius / dsFactor;
  const st = SPREAD * 32;
  for (const layer of [t.soft, t.bloom]) {
    pass(progBlur, t.tmp, dsW, dsH, (L) => {
      gl.uniform1f(L('uFlipY'), 0);
      gl.uniform2f(L('uTexel'), 1 / dsW, 1 / dsH);
      gl.uniform2f(L('uDir'), 1, 0);
      gl.uniform1f(L('uRadiusPx'), rds);
      gl.uniform1f(L('uSigmaTaps'), st);
      bindTex(0, layer.tex);
    });
    pass(progBlur, layer, dsW, dsH, (L) => {
      gl.uniform1f(L('uFlipY'), 0);
      gl.uniform2f(L('uTexel'), 1 / dsW, 1 / dsH);
      gl.uniform2f(L('uDir'), 0, 1);
      gl.uniform1f(L('uRadiusPx'), rds);
      gl.uniform1f(L('uSigmaTaps'), st);
      bindTex(0, t.tmp.tex);
    });
  }
  pass(progComp, dst, state.imgW, state.imgH, (L) => {
    gl.uniform1f(L('uFlipY'), dst ? 0 : 1);
    gl.uniform1f(L('uSharp'), p.sharp);
    gl.uniform1f(L('uBoost'), p.boost);
    gl.uniform1f(L('uOn'), 1);
    gl.uniform1i(L('uTex'), 0);
    gl.uniform1i(L('uSoft'), 1);
    gl.uniform1i(L('uBloom'), 2);
    bindTex(0, src);
    bindTex(1, t.soft.tex);
    bindTex(2, t.bloom.tex);
  });
}

export const bloomDef: FilterDef = {
  name: 'Bloom',
  kind: 'bloom',
  // radius is the glow's width in source pixels — 18px of glow is 18px
  // whatever the frame is, so the look is what you dial in, not what the
  // resolution decides. (The preview is the full-res render scaled down by
  // the browser, so preview and export always agree.)
  //
  // Defaults are the user's call (2026-11-05): radius 18px, thresh 0.8,
  // sharp 0.5, boost 1.0 — a tight, bright glow. The Bloom evaluation on a
  // hard-midday 4608×3456 frame had preferred the opposite: a wide, weak
  // "dreamy" bloom, where a narrow strong bloom rings every high-contrast
  // edge and reads as a phone filter.
  defaults: { radius: 18, thresh: 0.8, sharp: 0.5, boost: 1.0 },
  params: [
    { key: 'radius', min: 0, max: 150, step: 1, fmt: (v) => `${Math.round(v)} px` },
    { key: 'thresh', min: 0, max: 1, step: 0.01 },
    { key: 'sharp', min: 0, max: 1, step: 0.01 },
    { key: 'boost', min: 0.5, max: 1.5, step: 0.01 },
  ],
  prepare(p) {
    prepareBloom(p.radius ?? 0);
  },
  release() {
    releaseBloom();
  },
  clearSource() {
    releaseBloom();
  },
  describe() {
    return describeBloom();
  },
  render(src, dst, p) {
    renderBloom(src, dst, p);
  },
};
