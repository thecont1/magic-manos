/**
 * The handful of elements the app drives.
 *
 * A leaf module: it imports nothing, so every other module can reach the DOM
 * without any of them depending on each other.
 */

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

export const stage = $('stage');
export const canvas = $('gl') as HTMLCanvasElement;
export const empty = $('empty');
export const stat = $('stat');
export const side = $('side');
export const chip = $('chip');
export const dims = $('dims');
export const zoomSeg = $('zoomseg');

export const onToggle = $('on') as HTMLInputElement;
export const fileInput = $('file') as HTMLInputElement;
export const sampleBtn = $('sample') as HTMLButtonElement;
export const forgetBtn = $('forget') as HTMLButtonElement;
export const saveBtn = $('save') as HTMLButtonElement;
export const settingsBtn = $('settings') as HTMLButtonElement;
export const filterSel = $('filter') as HTMLSelectElement;
export const paramsHost = $('params');
export const resetBtn = $('reset') as HTMLButtonElement;
