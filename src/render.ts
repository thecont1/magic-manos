/**
 * The render loop.
 *
 * One filter is active at a time, and it is the only one allowed to hold
 * GPU resources: when the selection changes, the old filter is told to let
 * go of whatever it was holding. That is what keeps Bloom's ~64 MB of
 * working targets from sitting in memory while poppzz is running.
 */
import { stat } from './dom.js';
import { bindTex, gl, pass, progCopy, texFull } from './gl.js';
import { filterDef } from './registry.js';
import { state } from './state.js';
import type { FilterDef } from './types.js';

let rafQueued = false;
let activeOwner: FilterDef | null = null;

/** Free whatever the active filter was holding on to. */
export function releaseOwner(): void {
  activeOwner?.release?.();
  activeOwner = null;
}

// A one-pixel readback, used to make the reported time honest: gl.finish()
// only flushes the command buffer on most browsers, a readback is what
// actually syncs on GPU completion.
const px = new Uint8Array(4);

export function render(): void {
  if (!state.imgW) return;
  const t0 = performance.now();
  const def = filterDef(state.currentFilter);
  const p = state.params[state.currentFilter] ?? def.defaults;

  if (!state.on) {
    // The filter stage is off: show the source pixels, untouched — and let
    // go of the filter's resources, since nothing is drawing with them.
    releaseOwner();
    pass(progCopy, null, state.imgW, state.imgH, (L) => {
      gl.uniform1f(L('uFlipY'), 1);
      bindTex(0, texFull);
    });
  } else {
    if (def !== activeOwner) {
      releaseOwner();
      activeOwner = def;
    }
    def.prepare?.(p);
    def.render(texFull, null, p);
  }

  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const ms = (performance.now() - t0).toFixed(1);
  const what = def.describe?.() ?? '';
  stat.textContent = `${state.on ? `${def.name} · ${what} · ` : ''}render ${ms} ms`;
}

/** Draw on the next frame, at most once per frame however often it is called. */
export function scheduleRender(): void {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    render();
  });
}
