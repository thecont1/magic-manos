/**
 * Persistence: the panel's settings in localStorage, the picture in
 * IndexedDB.
 *
 * A full-resolution JPEG is far past what localStorage will hold, and
 * IndexedDB keeps it out of the URL. Nothing here touches the DOM — the
 * caller decides what to do with the result.
 */
import { FILTERS } from './registry.js';
import { state } from './state.js';

const STATE_KEY = 'magic-manos.state';
let stateTimer = 0;

/**
 * Keep every filter's parameters, the selected filter and the on/off switch,
 * so the lab comes back the way you left it — and so each filter holds its
 * own settings as more of them arrive.
 */
export function saveState(): void {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          filter: state.currentFilter,
          on: state.on,
          params: state.params,
        }),
      );
    } catch {
      // No storage (private mode, quota): the app still works, it just forgets.
    }
  }, 150);
}

/** Give every filter its default parameter values. */
export function initParams(): void {
  for (const key of Object.keys(FILTERS)) {
    state.params[key] = { ...FILTERS[key].defaults };
  }
}

/**
 * Read the saved state back. Anything unknown or out of range is dropped, so
 * a stale or hand-edited entry can never break the panel.
 */
export function restoreState(): void {
  initParams();
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object') return;
  const saved = raw as { filter?: unknown; on?: unknown; params?: Record<string, unknown> };

  if (typeof saved.filter === 'string' && FILTERS[saved.filter]) {
    state.currentFilter = saved.filter;
  }
  for (const key of Object.keys(FILTERS)) {
    const def = FILTERS[key];
    const stored = saved.params?.[key];
    if (!stored || typeof stored !== 'object') continue;
    for (const d of def.params) {
      const v = Number((stored as Record<string, unknown>)[d.key]);
      if (Number.isFinite(v)) state.params[key][d.key] = Math.min(d.max, Math.max(d.min, v));
    }
  }
  if (typeof saved.on === 'boolean') state.on = saved.on;
}

// --- the picture ------------------------------------------------------------

const DB_NAME = 'magic-manos', DB_STORE = 'images', DB_KEY = 'last';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  return dbPromise;
}

export async function rememberImage(blob: Blob, name: string): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ id: DB_KEY, name, blob, at: Date.now() });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    console.warn('could not remember the image:', e);
  }
}

export async function recallImage(): Promise<{ name: string; blob: Blob } | null> {
  try {
    const d = await db();
    const rec = await new Promise<{ id: string; name: string; blob: Blob } | undefined>((res, rej) => {
      const tx = d.transaction(DB_STORE, 'readonly');
      const rq = tx.objectStore(DB_STORE).get(DB_KEY);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return rec && rec.blob ? { name: rec.name, blob: rec.blob } : null;
  } catch (e) {
    console.warn('could not recall the image:', e);
    return null;
  }
}

export async function forgetImage(): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(DB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    console.warn('could not forget the image:', e);
  }
}
