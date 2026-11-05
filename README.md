# magic-manos

One-click filters, evaluated honestly.

## Run it

```sh
./serve.sh            # http://localhost:8000
# or: bun run start
# or just open index.html — it has no dependencies
```

Upload an image, pick a filter, tune its parameters, then **Settings ↓**
downloads the recipe as timestamped JSON and **Save PNG** exports the render
at full source resolution.

## Layout

- `index.html` — the whole app: WebGL pipeline, filter registry, UI.
- `bloom/` — reference material from the Bloom evaluation (Python port of the
  shader pipeline, parameter sweeps, verification captures, test photo).

Every option lives in the **left sidebar** — image picker, the filter on/off
switch, the filter picker, its parameter sliders, zoom, and the export
buttons — so the image gets the whole rest of the window. `Fit` letterboxes
the full picture in the stage; `100%` shows source pixels 1:1 and scrolls.
Under 700px the sidebar becomes a scrollable top strip.

## Filters

Filters live in the `FILTERS` registry in `index.html`. Each entry declares its
name, parameter surface (sliders are generated from it), and defaults.
**Bloom** is the first — thresholded highlight bloom over a downsampled
separable gaussian, composited under a sharp layer.
