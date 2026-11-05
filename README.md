# magic-manos

Photographic filter lab.

## Run it

```sh
./serve.sh            # http://localhost:8000
# or: bun run start
# or just open index.html — it has no dependencies
```

Upload an image, pick a filter, tune its parameters, then **Settings ↓**
downloads the recipe as timestamped JSON and **Save PNG** exports the render
at full source resolution. The last image is remembered: it comes back on its
own next time you open the app (**Clear image** empties the stage and drops
the remembered copy).

## Layout

- `index.html` — the whole app: WebGL pipeline, filter registry, UI.
- `bloom/` — reference material from the Bloom evaluation (Python port of the
  shader pipeline, parameter sweeps, verification captures, test photo).

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

Filters live in the `FILTERS` registry in `index.html`. Each entry declares its
name, parameter surface (sliders are generated from it), defaults, and a
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
the long edge (256–640px). Three maps are multiplied together:

- **colour rarity** — a smoothed Lab histogram of the frame; a pixel scores
  high when its colour is unusual. This is what makes the mask a *shape*
  rather than an outline: it holds across the whole interior of a flat object.
- **colour contrast** — the distance from the frame's mean Lab.
- **border contrast** — the distance from the mean colour along the edge of
  the frame, which is where the background usually is.

A wide gaussian centre prior keeps border clutter from winning. A gradient
detail term was tried first and dropped: detail only fires on edges, so the
mask came out as fragments of outlines rather than whole subjects.

Two details matter more than they look:

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
the biggest subject's area. What is left is ranked by total saliency and the
top `subjects` of them pop out.

**Compositing.** The mask is uploaded as one RGBA texture — R is the mask,
G/B carry each blob's pivot and A says whether a pivot is valid — so every
subject can scale about its own centre in a single pass. The mask is blurred
(the `feather` slider) for the soft boundary, and the edge is anti-aliased by
a floor of 1.2 texels, because the mask is a binary image and its texels
would otherwise show as facets along the silhouette.

| param | range | default | |
|---|---|---|---|
| scale | 1.000–1.100× | 1.030× | how much the subjects grow |
| feather | 0–40 px | 12 px | the softness of the boundary |
| bgDim | 0–60% | 18% | how much the background darkens |
| bgDesat | 0–100% | 12% | how much colour the background loses |
| shadow | 0–100% | 35% | the drop shadow off the subject |
| subjects | 1–5 | 3 | how many subjects to pop out |
| threshold | −0.20–+0.20 | 0.00 | bias on the Otsu cut |
| centerWeight | 0–1 | 0.40 | how hard the centre prior pulls |

The mask depends only on the picture, not on the sliders, so it is built once
when the image loads (~110ms, reported in the status line) and every slider
stays live at 60fps. The mask sliders (`subjects`, `threshold`,
`centerWeight`) change the mask itself, so they trigger a debounced rebuild.
The mask is only built for `poppzz` — a Bloom session never pays for it.

## State

The lab remembers itself. Each filter's parameter values, the selected filter
and the on/off switch are kept in `localStorage`, so the panel comes back the
way you left it and every filter holds its own settings as more of them
arrive. Anything unreadable or out of range in a saved entry is discarded on
load rather than trusted.

The last *image* is kept separately, in IndexedDB, since a full-resolution
file is far past what `localStorage` will hold.

