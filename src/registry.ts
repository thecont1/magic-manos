/**
 * The filter registry: every filter the lab offers, keyed by its id.
 *
 * Exactly one filter is selected at a time. A filter brings its own name,
 * its own parameter surface and its own renderer — adding one means adding
 * a module here, and touching nothing else.
 */
import { bloomDef } from './filters/bloom.js';
import { poppzzDef } from './filters/poppzz.js';
import type { FilterDef } from './types.js';

export const FILTERS: Record<string, FilterDef> = {
  bloom: bloomDef,
  poppzz: poppzzDef,
};

/** The filter with the given id — throws if there is no such filter. */
export function filterDef(key: string): FilterDef {
  const d = FILTERS[key];
  if (!d) throw new Error(`unknown filter: ${key}`);
  return d;
}
