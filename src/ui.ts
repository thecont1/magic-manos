/**
 * The control panel: the filter picker and the selected filter's parameters.
 *
 * The registry says what the rows are; this module turns that into DOM and
 * keeps it in step with the state.
 */
import { chip, filterSel, onToggle, paramsHost, side, stage } from './dom.js';
import { saveState } from './persist.js';
import { filterDef, FILTERS } from './registry.js';
import { scheduleRender } from './render.js';
import { state } from './state.js';
import type { ParamSpec } from './types.js';

let sliders: Record<string, HTMLInputElement> = {};
let outputs: Record<string, HTMLOutputElement> = {};

const fmt = (d: ParamSpec, v: number): string => (d.fmt ? d.fmt(v) : v.toFixed(2));

/**
 * Build the filter section from the registry: the picker lists every filter,
 * and the parameter rows below belong to the selected one — only the
 * relevant ones, since each filter declares its own surface.
 */
export function buildControls(): void {
  filterSel.textContent = '';
  for (const [key, f] of Object.entries(FILTERS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = f.name;
    filterSel.append(o);
  }
  filterSel.value = state.currentFilter;

  paramsHost.textContent = '';
  sliders = {};
  outputs = {};
  const def = filterDef(state.currentFilter);
  const values = state.params[state.currentFilter] ?? def.defaults;

  for (const d of def.params) {
    const row = document.createElement('div');
    row.className = 'prow';
    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.textContent = d.key;
    const out = document.createElement('output');
    out.textContent = fmt(d, values[d.key] ?? d.min);
    head.append(name, out);

    if (d.type === 'bool') {
      // A checkbox rather than a slider: on or off, nothing in between.
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = `${state.currentFilter}-${d.key}`;
      box.checked = !!values[d.key];
      box.setAttribute('aria-label', `${def.name} ${d.key}`);
      row.className = 'prow bool';
      row.append(head, box);
      paramsHost.append(row);
      sliders[d.key] = box;
      outputs[d.key] = out;
      box.addEventListener('input', () => {
        state.params[state.currentFilter][d.key] = box.checked ? 1 : 0;
        out.textContent = fmt(d, state.params[state.currentFilter][d.key]);
        scheduleRender();
        saveState();
      });
      continue;
    }

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `${state.currentFilter}-${d.key}`;
    input.min = String(d.min);
    input.max = String(d.max);
    input.step = String(d.step);
    input.value = String(values[d.key] ?? d.min);
    input.setAttribute('aria-label', `${def.name} ${d.key}`);
    row.append(head, input);
    paramsHost.append(row);
    sliders[d.key] = input;
    outputs[d.key] = out;
    input.addEventListener('input', () => {
      state.params[state.currentFilter][d.key] = parseFloat(input.value);
      out.textContent = fmt(d, state.params[state.currentFilter][d.key]);
      scheduleRender();
      saveState();
      // A mask slider changes the mask itself, not just the composite.
      def.paramChanged?.(d.key);
    });
  }
  chip.textContent = def.name;
}

/** Refresh the value readouts without touching the controls themselves. */
export function syncOutputs(): void {
  const def = filterDef(state.currentFilter);
  const values = state.params[state.currentFilter] ?? def.defaults;
  for (const d of def.params) {
    const out = outputs[d.key];
    if (out) out.textContent = fmt(d, values[d.key]);
  }
}

/** Put the selected filter's defaults back. */
export function resetControls(): void {
  const key = state.currentFilter;
  state.params[key] = { ...filterDef(key).defaults };
  for (const [k, el] of Object.entries(sliders)) {
    // A checkbox is set by `checked`, not by `value`.
    if (el.type === 'checkbox') el.checked = !!state.params[key][k];
    else el.value = String(state.params[key][k]);
    el.dispatchEvent(new Event('input'));
  }
  saveState();
}

/**
 * The switch drives two things: whether the filter stage runs at all, and
 * whether the panel reads as live or dimmed.
 */
export function syncToggleUI(): void {
  onToggle.checked = state.on;
  stage.classList.toggle('on', state.on);
  side.classList.toggle('off', !state.on);
}
