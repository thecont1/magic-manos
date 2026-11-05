/**
 * The WebGL layer: the context, the shaders more than one filter needs, and
 * the three primitives everything else is built from — a render target, a
 * texture bind, and a pass.
 */
import { canvas, empty } from './dom.js';
import type { Target } from './types.js';

const ctx =
  canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true }) ||
  canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });

if (!ctx) {
  empty.innerHTML = 'WebGL is not available in this browser.';
  throw new Error('no webgl');
}

export const gl: WebGLRenderingContext = ctx;
export const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

// uFlipY selects the UV mapping per pass. Browser-uploaded textures are
// row-0-top, so canvas output samples them flipped (uFlipY=1). FBO passes
// render unflipped (uFlipY=0), which makes FBO row 0 the image top as well —
// every texture then reads v=0 = top under one convention. This is all
// because UNPACK_FLIP_Y_WEBGL is not reliably honored for ImageBitmap sources.
const VERT = `
attribute vec2 aPos;
uniform float uFlipY;
varying vec2 vUV;
void main() {
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 + aPos.y * 0.5 * (uFlipY > 0.5 ? -1.0 : 1.0));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
`;

// Machinery, not creative controls — fixed like the original script's σ=3.
// Sigma is a fraction of the kernel half-span (σ=3 over N=6 → 0.5).
export const SPREAD = 0.5;

// Separable gaussian, one axis per pass (uDir), taps spread across uRadiusPx
// in THIS texture's pixels — at downsampled res the spacing stays ≤ ~1px so
// there is no sparse-tap ghosting. A gaussian is exactly separable, so H+V
// equals the reference 2D kernel at a fraction of the cost.
const FRAG_BLUR = PRELUDE + `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uRadiusPx;
uniform float uSigmaTaps;
void main() {
  const int N = 32;
  float twoSigma2 = 2.0 * uSigmaTaps * uSigmaTaps;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -N; i <= N; i++) {
    float fi = float(i);
    float w = exp(-(fi * fi) / twoSigma2);
    vec2 o = vUV + uDir * ((fi / float(N)) * uRadiusPx) * uTexel;
    sum += texture2D(uTex, o) * w;
    total += w;
  }
  gl_FragColor = sum / total;
}`;

// A plain copy: the source pixels and nothing else. Used when the filter
// stage is switched off, and when poppzz has no mask yet — neither of them
// needs Bloom's working targets, which are large.
const FRAG_COPY = PRELUDE + `
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

// --- programs ---------------------------------------------------------------

type Uniforms = Record<string, WebGLUniformLocation | null>;
const UL = new Map<WebGLProgram, Uniforms>();

function compile(type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('could not create a shader');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
  }
  return s;
}

/**
 * Link a fragment shader into a program and enumerate its uniforms once.
 * Lookups return null for anything the compiler dropped, which the
 * uniform*() calls then harmlessly ignore.
 */
export function makeProgram(fragSrc: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('could not create a program');
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed');
  }
  const m: Uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const u = gl.getActiveUniform(p, i);
    if (!u) continue;
    m[u.name] = gl.getUniformLocation(p, u.name);
  }
  UL.set(p, m);
  return p;
}

export const progBlur = makeProgram(FRAG_BLUR);
export const progCopy = makeProgram(FRAG_COPY);

// --- the geometry -----------------------------------------------------------

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

// --- the source texture -----------------------------------------------------

export const texFull = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texFull);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
// Mipmapped when WebGL2 allows it on this NPOT source: the downsample passes
// then get true area filtering for free. WebGL1 falls back to plain bilinear
// (slightly aliased downsample — acceptable, the blur hides it).
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, isGL2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);

/** Put the source pixels into the one full-resolution texture. */
export function uploadFull(src: TexImageSource): void {
  gl.bindTexture(gl.TEXTURE_2D, texFull);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (isGL2) gl.generateMipmap(gl.TEXTURE_2D);
}

// --- the primitives ---------------------------------------------------------

export function makeTarget(w: number, h: number): Target {
  const tex = gl.createTexture();
  if (!tex) throw new Error('could not create a texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('could not create a framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

export function deleteTarget(t: Target): void {
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

export function bindTex(unit: number, tex: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

/** Look a uniform up in the program that is about to draw. */
export type UniformLocator = (name: string) => WebGLUniformLocation | null;

/** Draw a full-screen quad with `prog`, into `target` or the screen. */
export function pass(
  prog: WebGLProgram,
  target: Target | null,
  w: number,
  h: number,
  setup: (L: UniformLocator) => void,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);
  const m = UL.get(prog) ?? {};
  setup((n) => m[n] ?? null);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
