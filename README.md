# magic-manos

Photographic filter lab.

## Run it

```sh
npm install            # once — TypeScript, and nothing else
npm start              # builds to dist/ and serves http://localhost:8000
# or, in another shell: npm run watch   (rebuilds on save)
```

The app needs a static server — it is built as ES modules, and browsers do
not load those from `file://`. `./serve.sh` serves the repo without building,
so use it only after a `npm run build`.

Upload an image, pick a filter, tune its parameters, then **Settings ↓**
downloads the recipe as timestamped JSON and **Save PNG** exports the render
at full source resolution. The last image is remembered: it comes back on its
own next time you open the app (**Clear image** empties the stage and drops
the remembered copy).

## Layout

```
index.html            the markup — nothing else
css/app.css           the design: palette, panels, sliders, the switch
src/                  TypeScript, the source of truth
  app.ts                the shell: loading, export, the keyboard
  gl.ts                 the WebGL layer: context, programs, targets, pass()
  state.ts              the app's mutable state
  registry.ts           the filter registry
  ui.ts                 the control panel
  persist.ts            localStorage and IndexedDB
  filters/
    bloom.ts            Bloom's shaders, targets, renderer and parameters
    poppzz.ts           poppzz's shaders, mask textures, renderer, parameters
    poppzz-saliency.ts  the saliency pipeline — pure, no DOM, no WebGL
dist/                 the built app (gitignored)
lab/                  the evaluation rigs — tuning, not shipping
  bloom/                a Python port of the Bloom shader pipeline, sweeps
  poppzz/               the saliency harness and its hand-marked ground truth
  shots/                test photographs and verification captures
```

The rule the tree follows: **design in `css/`, logic in `src/`, and one
filter per module.** A filter owns its shaders, its working targets, its
parameter surface and its renderer; the panel is generated from what the
filter declares, so adding a filter means adding a file and touching nothing
else.

`src/filters/poppzz-saliency.ts` is deliberately pure — no DOM, no WebGL, no
globals. That is what lets `lab/poppzz/` measure the pipeline the browser
actually runs, rather than a copy of it.

Everything lives in the **left sidebar**, in three demarcated panels:

- **Image** — the file picker, “Load Test pattern”, clear, the image
  dimensions, and zoom. `Fit` letterboxes the full picture in the stage; `100%`
  shows source pixels 1:1 and scrolls.
- **Filter** — the master on/off switch, the filter dropdown (one filter at a
  time), and below it the selected filter's own parameters. Picking a filter
  swaps the parameter group to match.
- **Export** — Save PNG and the Settings recipe download.

Each section wears its title on a header bar, square-cornered at the top, with
the contents sitting below it.

The stage gets the whole rest of the window. Under 700px the sidebar becomes a
scrollable top strip.

## Filters

Filters live in the `FILTERS` registry in `src/registry.ts`. Each entry declares
its name, parameter surface (sliders are generated from it), defaults, and a
`kind` that picks its renderer.
**Bloom** is the first — thresholded highlight bloom over a downsampled
separable gaussian, composited under a sharp layer.

| param | range | default | |
|---|---|---|---|
| radius | 0–150 px | 18 px | the glow's width in source pixels |
| thresh | 0–1 | 0.80 | only pixels brighter than this bloom |
| sharp | 0–1 | 0.50 | how much of the sharp layer survives |
| boost | 0.5–1.5 | 1.00 | how hard the glow pushes |

Exactly one filter is selected at a time. A filter with its own pipeline gets
a renderer in `RENDERERS`.

### poppzz

`poppzz` finds the *main objects* in a picture and makes them look like they
are standing in front of it. The subjects are found by classical saliency,
thresholded into a mask, and then each subject is magnified about its own
centroid and laid over the untouched original, while the background is dimmed
and desaturated. A soft drop shadow off the blurred mask finishes the effect.

Nothing is downloaded and no model is involved: the whole thing is a
deterministic, dependency-free pipeline that runs in the browser.

**Finding the subject.** The mask is built on a copy of the picture a third of
the long edge (256–640px). Four maps are multiplied together:

- **colour rarity** — a smoothed Lab histogram of the frame; a pixel scores
  high when its colour is unusual. This is what makes the mask a *shape*
  rather than an outline: it holds across the whole interior of a flat object.
- **colour contrast** — the distance from the frame's mean Lab.
- **border contrast** — the distance from the mean colour along the edge of
  the frame, which is where the background usually is.
- **centre prior** — a wide gaussian, so border clutter does not win outright.

A gradient detail term was tried first and dropped: detail only fires on
edges, so the mask came out as fragments of outlines rather than whole
subjects.

**Why a product, and with what exponents.** The four terms are combined as a
**product of powers**, not as a weighted mean. This was measured, not assumed.
A weighted geometric mean (weights summing to 1) smooths the map into a
single hump; Otsu then cuts that hump in half and calls half the photograph a
subject — measured on the Ritz photo, a 0.40/0.20/0.15/0.25 mean cut at
0.4706, kept 33% of the frame, and isolated **none** of the three subjects.
Taking a root before thresholding (`S ** 0.25`, the obvious fix for a
skewed map) makes it worse, not better: it pulls the near-zero background
mass *up* towards the subjects, the cut moves to 0.4627, and the whole frame
becomes one blob.

A product keeps the map bimodal — background mass down near zero, subjects
standing clear above it — which is the shape Otsu is built to split. The
exponents sum to 4, the number of terms, so the map keeps a product's shape
while the ratios say what counts for more: rarity and the centre prior weigh
more than the two contrast terms. `W_RARE = 1.2, W_COLOR = 0.8,
W_BORDER = 0.8, W_PRIOR = 1.2`.

**The floor.** One term at exactly zero would annihilate the pixel, and a pale
grey-blue kurta against a stone wall is very nearly zero on the border term.
Every term is lifted off zero (`TERM_FLOOR = 0.05`) before it is raised to its
power, so no single weak term can wipe a pixel out.

What the crowded low end actually needed was **more histogram bins**: Otsu
runs with **1024 bins** on the product map, not 256. At 256 bins the mass near
zero is crushed into the first few and the cut lands on a coarse step.

Two more details matter more than they look:

- The blur the saliency sees is measured in **source pixels** (18 of them),
  not in texels of the mask copy. In texels it would be a much tighter blur
  at 640px than at 256px, and a subject with texture — a woven sari, say —
  would be cut into pieces instead of coming out whole.
- The blur is three **box passes**, not a gaussian. A gaussian's cost grows
  with its radius, and the radius grows with the mask resolution: three
  gaussian planes came to 150ms at 640px. A box pass is a running sum, so it
  costs the same whatever the radius.

The product is thresholded with Otsu (the `threshold` slider biases the cut),
cleaned with a morphological close and open, split into connected components,
and the specks are dropped: a blob has to clear 1.5% of the frame, or 20% of
the biggest subject's area.

**Which blobs are subjects.** The blobs are ranked by **total saliency** —
the sum of the saliency map over the blob — and the top `subjects` of them pop
out. Two filters sit on top of that ranking:

- **Solidity.** A blob has to fill at least 30% of its own bounding box
  (`MIN_FILL`) to be eligible at all. A hedge is lacework — it fills its
  bounding box in a scatter, not a shape — and a tree canopy is the same.
  Ranking by fill ratio instead of filtering on it does not work: it demotes
  the large, real foreground sari below a small solid bench blob.
- **Edge penalty.** A blob that runs off the edge of the frame was never a
  whole object; its score is halved rather than discarded, because the
  subject sometimes really does touch the edge.

If the solidity filter would empty the mask, the unfiltered set is used.

**Compositing.** The mask is uploaded as one RGBA texture — R is the mask,
G/B carry each blob's pivot and A says whether a pivot is valid — so every
subject can scale about its own centre in a single pass. The mask is blurred
(the `feather` slider) for the soft boundary, and the edge is anti-aliased by
a floor of 1.2 texels, because the mask is a binary image and its texels
would otherwise show as facets along the silhouette.

Three things about that single pass are easy to get wrong:

- The pivot map is sampled with **linear** filtering, so at a blob's edge the
  pivot channels and the validity flag are both ramped down towards zero and
  the pivot drifts towards (0,0) exactly where the silhouette is visible. They
  ramp together, so dividing one by the other puts the pivot back:
  `vec2 pivot = pv.gb / max(pv.a, 1e-3);`
- A pivot written only at the largest scale leaves concave subjects full of
  holes — the pixels under an outstretched arm, or between two spires, have
  no pivot and fall back to the dimmed background. The pivot map is therefore
  warped at **three scales** (`1`, the middle, and the maximum) and each blob
  stamps its own pixels at scale 1.
- The background is dimmed everywhere, including *under* the subject, so the
  enlarged subject's feathered edge blends against a dimmed copy of the
  subject's own edge pixels and reads as a **dark ring** inside the
  silhouette. The original pixels are put back under the unscaled mask,
  after the dim and desaturation and before the shadow.

| param | range | default | |
|---|---|---|---|
| scale | 1.000–1.100× | 1.030× | how much the subjects grow |
| feather | 0–40 px | 12 px | the softness of the boundary |
| bgDim | 0–60% | 18% | how much the background darkens |
| bgDesat | 0–100% | 12% | how much colour the background loses |
| shadow | 0–100% | 35% | the drop shadow off the subject |
| subjects | 1–5 | 3 | how many subjects to pop out |
| threshold | −0.06–+0.06 | 0.00 | bias on the Otsu cut, step 0.005 |
| centerWeight | 0–1 | 0.40 | how hard the centre prior pulls |
| debug | off/on | off | show the saliency map and the mask |

**The debug view** replaces the composite with what the pipeline is actually
doing: grey is the saliency map, red everything that came out of the
threshold, green the blobs that were kept as subjects, and blue their
outlines. It is a `bool` parameter of the filter, so it persists with the
filter's state and only exists for `poppzz`.

The mask depends only on the picture, not on the sliders, so it is built once
when the image loads (~160ms on a 2271×1703 frame, reported in the status
line) and every slider stays live at 60fps. The mask sliders (`subjects`,
`threshold`, `centerWeight`) change the mask itself, so they trigger a
debounced rebuild. The mask is only built for `poppzz` — a Bloom session never
pays for it.

**Keeping it cheap.** The mask is built once, but the live render is on every
slider tick, so:

- The blurred mask is **cached** on the mask version and the feather value;
  it is only re-blurred when one of those actually changes.
- Bloom's working targets (including the ~64MB full-resolution threshold
  buffer at 4608×3456) are allocated **only while Bloom is the running
  filter** and released when another filter takes over. A separate copy
  shader handles the filter-off path, so `poppzz` never allocates them at all.
- `rgbToLab` writes into a caller-supplied array instead of returning a new
  one per pixel, and the four fractional powers are tabulated — 1.2 million
  `Math.pow` calls per rebuild becomes four table lookups per pixel.

## State

The lab remembers itself. Each filter's parameter values, the selected filter
and the on/off switch are kept in `localStorage`, so the panel comes back the
way you left it and every filter holds its own settings as more of them
arrive. Anything unreadable or out of range in a saved entry is discarded on
load rather than trusted.

The last *image* is kept separately, in IndexedDB, since a full-resolution
file is far past what `localStorage` will hold.

## The lab

`lab/` holds the rigs used to *tune* the filters — they are not part of the
app and nothing in `src/` depends on them.

`lab/poppzz/` measures the saliency pipeline against hand-marked ground
truth:

```sh
npm run lab          # measure every photograph, report PASS or FAIL
npm run lab:check    # the same, but a failure exits non-zero
npm run lab:sweep    # sweep the knobs and the constants
```

It imports `src/filters/poppzz-saliency.ts` — the module the browser actually
runs — so what it measures is what ships. Each photograph is a real picture at
the size the app's mask copy actually is (640×480, a third of the long edge,
clamped), scored against boxes marked by hand: subjects that must be found,
background regions that must not be, and *optional* regions — neither clearly
one nor the other — that are measured but never decide the verdict.

Two photographs are measured:

- **the Ritz photo** (`lab/shots/ritz-carlton-bangalore.jpg`) — three
  subjects, seven background regions. It passes: three subjects found, none
  of them touching the background, kept area 5.65% of the frame.
- **the temple photo** (`lab/shots/temple-oneplus.jpg`) — a selfie: a man in
  a red shirt, a woman holding a phone, the gopuram behind them and a bank of
  bougainvillea. It **fails**, and the failure is informative: poppzz keeps
  the man's shirt, his hair and the bougainvillea, and drops the woman's face
  as a speck. The solidity and edge rules cannot catch it, because the
  flowers are a solid mass rather than lacework — colour-rarity saliency is
  built to find exactly that.

The harness writes a preview of each mask to `lab/poppzz/out/`, and prints
every candidate blob with the reason it was kept or dropped.

`lab/bloom/` is the older rig: a Python port of the Bloom shader pipeline, so
recipes could be swept offline instead of round-tripping through the browser,
plus a check that the port still matches the app.

One photograph is not enough to tell a formulation that works from one that
happens to fit that frame — the ground truth needs at least two.



