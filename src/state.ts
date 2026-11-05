/**
 * The app's mutable state, in one place.
 *
 * Everything that outlives a single call — the selected filter, each filter's
 * parameter values, the image's dimensions — lives here, so the modules that
 * read them do not have to know about each other.
 */
import type { ParamValues } from './types.js';

export interface AppState {
  /** The source image's dimensions; 0 when there is no image. */
  imgW: number;
  imgH: number;
  /** The filter stage's master switch. */
  on: boolean;
  /** Which filter is selected — a key into the registry. */
  currentFilter: string;
  /** Each filter's own parameter values, so switching back keeps a tweak. */
  params: Record<string, ParamValues>;
  /** The loaded file's name, for the recipe export. */
  imageName: string | null;
}

export const state: AppState = {
  imgW: 0,
  imgH: 0,
  on: true,
  currentFilter: 'bloom',
  params: {},
  imageName: null,
};
