/**
 * The app shell.
 *
 * It owns the things that belong to the app rather than to any one part —
 * loading a picture, exporting it, the keyboard — and wires the rest
 * together.
 */
import {
  canvas, dims, empty, fileInput, filterSel, forgetBtn, onToggle,
  resetBtn, sampleBtn, saveBtn, settingsBtn, stage, stat, zoomSeg,
} from './dom.js';
import { onMaskRebuilt } from './filters/poppzz.js';
import { uploadFull } from './gl.js';
import {
  forgetImage, initParams, recallImage, rememberImage, restoreState, saveState,
} from './persist.js';
import { filterDef, FILTERS } from './registry.js';
import { releaseOwner, render, scheduleRender } from './render.js';
import { state } from './state.js';
import { buildControls, resetControls, syncOutputs, syncToggleUI } from './ui.js';

// --- the picture ------------------------------------------------------------

async function loadFile(file: File): Promise<void> {
  state.imageName = file.name;
  void rememberImage(file, file.name);
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    uploadSource(bmp, bmp.width, bmp.height);
    bmp.close();
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      uploadSource(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
}

function uploadSource(src: TexImageSource, w: number, h: number): void {
  state.imgW = w;
  state.imgH = h;
  canvas.width = w;
  canvas.height = h;
  uploadFull(src);
  // The working targets belong to whichever filter is running; the render
  // loop sorts that out, and frees Bloom's buffers when another filter takes
  // over. Releasing here matters when the image size changed but the
  // downsample factor did not — the targets would otherwise still be the
  // old size.
  releaseOwner();
  for (const def of Object.values(FILTERS)) def.prepareSource?.(src, w, h);
  empty.hidden = true;
  canvas.hidden = false;
  saveBtn.disabled = false;
  forgetBtn.hidden = false;
  dims.textContent = `${w} × ${h}`;
  syncOutputs();
  render();
}

/** Clear the image: drop the remembered copy and empty the stage. */
async function clearImage(): Promise<void> {
  await forgetImage();
  state.imgW = 0;
  state.imgH = 0;
  state.imageName = null;
  releaseOwner();
  for (const def of Object.values(FILTERS)) def.clearSource?.();
  canvas.hidden = true;
  empty.hidden = false;
  saveBtn.disabled = true;
  forgetBtn.hidden = true;
  dims.textContent = '—';
  stat.textContent = 'no image';
}

/** Bring back the last picture on the next visit. */
async function restoreLastImage(): Promise<void> {
  const rec = await recallImage();
  if (!rec) return;
  state.imageName = rec.name;
  try {
    const bmp = await createImageBitmap(rec.blob, { imageOrientation: 'from-image' });
    uploadSource(bmp, bmp.width, bmp.height);
    bmp.close();
    forgetBtn.hidden = false;
  } catch (e) {
    console.warn('could not restore the image:', e);
  }
}

function testPattern(): void {
  const w = 1440, h = 900, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  if (!x) return;
  const sky = x.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#ffb066'); sky.addColorStop(.45, '#8a5f9e'); sky.addColorStop(1, '#1c1430');
  x.fillStyle = sky; x.fillRect(0, 0, w, h);
  const sun = x.createRadialGradient(w * .68, h * .42, 8, w * .68, h * .42, 170);
  sun.addColorStop(0, '#fff6dd'); sun.addColorStop(.25, '#ffd98a'); sun.addColorStop(1, '#ffd98a00');
  x.fillStyle = sun; x.fillRect(0, 0, w, h);
  x.fillStyle = '#171226';
  x.beginPath(); x.moveTo(0, h * .72);
  for (let i = 0; i <= 12; i++) x.lineTo(w * i / 12, h * .72 - Math.sin(i * 1.7) * 60 - 40);
  x.lineTo(w, h); x.lineTo(0, h); x.fill();
  x.fillStyle = '#0d0a18';
  x.fillRect(w * .08, h * .42, w * .3, h * .58);
  x.fillStyle = '#ffe9b0';
  for (let r = 0; r < 7; r++) for (let col = 0; col < 4; col++)
    if ((r + col) % 3) x.fillRect(w * .1 + col * w * .07, h * .46 + r * h * .075, w * .035, h * .038);
  const cols = ['#ff5470', '#3ec6ff', '#ffe066', '#7dff9b'];
  cols.forEach((col, i) => {
    x.fillStyle = col;
    x.beginPath(); x.arc(w * (.55 + i * .09), h * .8, 26, 0, 7); x.fill();
  });
  x.strokeStyle = '#ffffff'; x.lineWidth = 2;
  x.strokeRect(w * .86, h * .1, 90, 60);
  state.imageName = 'test-pattern';
  uploadSource(c, w, h);
  // The test pattern is remembered too — it is the picture that is loaded.
  c.toBlob((b) => { if (b) void rememberImage(b, 'test-pattern'); }, 'image/png');
}

// --- the exports ------------------------------------------------------------

function savePNG(): void {
  render();
  canvas.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${state.currentFilter}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}

/**
 * Download the selected filter + its params as versioned JSON — the timestamp
 * is the version stamp of the recipe record.
 */
function saveRecipe(): void {
  const def = filterDef(state.currentFilter);
  const data = {
    version: new Date().toISOString(),
    app: 'magic-manos',
    filter: state.currentFilter,
    name: def.name,
    params: { ...state.params[state.currentFilter] },
    image: state.imageName,
    imageSize: state.imgW ? [state.imgW, state.imgH] : null,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `magic-manos-${data.version.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// --- wiring -----------------------------------------------------------------

/** Give the selected filter a chance to build what it needs before it draws. */
function ensureReady(): void {
  filterDef(state.currentFilter).ensureReady?.();
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
});
sampleBtn.addEventListener('click', testPattern);
forgetBtn.addEventListener('click', () => void clearImage());
saveBtn.addEventListener('click', savePNG);
settingsBtn.addEventListener('click', saveRecipe);

onToggle.addEventListener('change', () => {
  state.on = onToggle.checked;
  syncToggleUI();
  ensureReady();
  saveState();
  scheduleRender();
});

filterSel.addEventListener('change', () => {
  state.currentFilter = filterSel.value;
  buildControls();
  ensureReady();
  saveState();
  scheduleRender();
});

resetBtn.addEventListener('click', resetControls);

zoomSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  for (const s of Array.from(b.parentElement?.children ?? [])) s.classList.toggle('on', s === b);
  stage.classList.toggle('z100', b.dataset.z === 'z100');
  stage.classList.toggle('fit', b.dataset.z !== 'z100');
});

for (const ev of ['dragenter', 'dragover']) {
  stage.addEventListener(ev, (e) => {
    e.preventDefault();
    stage.classList.add('drag');
  });
}
for (const ev of ['dragleave', 'drop']) {
  stage.addEventListener(ev, (e) => {
    const de = e as DragEvent;
    e.preventDefault();
    if (ev === 'dragleave' && de.relatedTarget instanceof Node && stage.contains(de.relatedTarget)) return;
    stage.classList.remove('drag');
    if (ev === 'drop') {
      const f = de.dataTransfer?.files[0];
      if (f) void loadFile(f);
    }
  });
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
  if (e.key === 'f') {
    onToggle.checked = !onToggle.checked;
    onToggle.dispatchEvent(new Event('change'));
  } else if (e.key === 's' && !saveBtn.disabled) {
    saveBtn.click();
  } else if (e.key === '1') {
    (zoomSeg.querySelector('[data-z="z100"]') as HTMLElement | null)?.click();
  } else if (e.key === '0') {
    (zoomSeg.querySelector('[data-z="fit"]') as HTMLElement | null)?.click();
  }
});

// --- start ------------------------------------------------------------------

initParams();
restoreState();
buildControls();
// The saved state may have left the filter stage switched on.
syncToggleUI();
// When the mask is rebuilt, the stage needs to be redrawn.
onMaskRebuilt(scheduleRender);
void restoreLastImage();
