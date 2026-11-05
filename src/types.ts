/**
 * The contracts the modules share.
 *
 * A leaf module: it imports nothing, so every other module can depend on it
 * without any of them depending on each other.
 */

/** A render target: a texture with a framebuffer attached to it. */
export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/** One filter's parameter values, keyed by the parameter's name. */
export type ParamValues = Record<string, number>;

interface ParamBase {
  /** The parameter's name — also the key it is stored under. */
  key: string;
  min: number;
  max: number;
  step: number;
  /** How the value is shown next to the control. */
  fmt?: (v: number) => string;
  /**
   * This parameter changes the mask itself rather than just the composite,
   * so moving it rebuilds the mask instead of redrawing.
   */
  mask?: boolean;
}

/** A parameter the user dials: a slider between `min` and `max`. */
export interface RangeParam extends ParamBase {
  type?: 'range';
}

/** A parameter the user flips: on or off, nothing in between. */
export interface BoolParam extends ParamBase {
  type: 'bool';
}

export type ParamSpec = RangeParam | BoolParam;

/**
 * A filter, all in one place: what it is called, the surface it exposes, and
 * how it draws itself. A filter that needs no GPU resources simply leaves
 * `prepare`/`release` out.
 */
export interface FilterDef {
  /** The name shown in the dropdown and on the stage's chip. */
  name: string;
  /** Which renderer draws it. */
  kind: string;
  /** The parameter values a fresh start uses. */
  defaults: ParamValues;
  /** The parameter surface — the sliders and switches the panel shows. */
  params: ParamSpec[];
  /** Called when one of this filter's parameters changes. */
  paramChanged?(key: string): void;
  /** Called when a new image arrives, so the filter can look at it. */
  prepareSource?(src: TexImageSource, w: number, h: number): void;
  /**
   * Called when the filter is about to be shown or switched on — build
   * whatever it needs, so the first frame is not the expensive one.
   */
  ensureReady?(): void;
  /** Called before the filter draws — allocate whatever it needs. */
  prepare?(p: ParamValues): void;
  /**
   * Called when this filter stops being the active one — free what is only
   * worth keeping while it is drawing. (A filter's per-image work is NOT
   * released here; that is what `clearSource` is for.)
   */
  release?(): void;
  /**
   * Called when the image goes away — free everything derived from it.
   */
  clearSource?(): void;
  /** The middle section of the status line. */
  describe?(): string;
  /** Draw the filter. `dst` is null when drawing to the screen. */
  render(src: WebGLTexture, dst: Target | null, p: ParamValues): void;
}
