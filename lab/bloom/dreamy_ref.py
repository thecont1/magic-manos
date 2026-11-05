"""
Python reference for the WebGL "dreamy" filter in dreamy-filter-demo.html.

Ported from the shader pipeline so parameters can be swept and measured
without a browser round-trip. Everything happens in sRGB code values,
because the shader samples an RGBA8 texture (not SRGB8_ALPHA8) and does all
threshold/blur/add math on those raw values.

Pipeline (demo lines 356-407):
  thr   = max(full - thresh, 0)                     # full res, hard knee
  soft  = downsample(full)      -> blur -> upsample # whole image, softened
  bloom = downsample(thr)       -> blur -> upsample # highlights only
  out   = soft*(1-sharp) + full*sharp + bloom*boost # clipped to 0..1
"""

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter1d

SRC = "/Users/home/Downloads/IMG_20260129_161241.jpg"

# Machinery constants copied from the demo.
SPREAD = 0.5          # sigma is a fraction of the kernel half-span
TAPS = 32             # N in the blur loop; sigma_taps = SPREAD * TAPS


def ds_factor(radius, img_w):
    """Downsample factor, matching DS() in the demo."""
    r = max(1.0, radius * img_w)
    import math
    return min(16, max(2, 2 ** math.ceil(math.log2(r / 24.0))))


def _resize(arr, w, h, box=False):
    """Resize a float32 HxWx3 array (per channel, PIL has no float RGB mode)."""
    f = Image.BOX if box else Image.BILINEAR
    chans = []
    for c in range(arr.shape[2]):
        im = Image.fromarray(arr[:, :, c].astype(np.float32), mode="F")
        chans.append(np.asarray(im.resize((w, h), f), dtype=np.float32))
    return np.stack(chans, axis=2)


def _blur_ds(arr, sigma_px):
    """Separable gaussian on a downsampled buffer.

    The shader's kernel spans +/-32 taps at 1/32 of the radius, so the
    gaussian is truncated at 2 sigma (weight exp(-2) at the edge) and
    normalised. scipy's gaussian_filter1d with truncate=2.0 and
    mode='nearest' matches that closely enough.
    """
    if sigma_px <= 0:
        return arr
    return gaussian_filter1d(
        gaussian_filter1d(arr, sigma_px, axis=0, truncate=2.0, mode="nearest"),
        sigma_px, axis=1, truncate=2.0, mode="nearest",
    )


def dreamy(full, radius, thresh, sharp, boost):
    """Run the pipeline. `full` is HxWx3 float32 in 0..1 (sRGB code values)."""
    h, w = full.shape[:2]
    ds = ds_factor(radius, w)
    dw, dh = max(1, round(w / ds)), max(1, round(h / ds))

    # threshold at full res so speculars of any size survive the downsample
    thr = np.maximum(full - thresh, 0.0)

    # soft layer: area downsample (the mipmapped source gives area filtering)
    soft_ds = _resize(full, dw, dh, box=True)
    # bloom layer: bilinear downsample of the already-thresholded image
    bloom_ds = _resize(thr, dw, dh, box=False)

    # radius in downsampled pixels; sigma is half of that (SPREAD = 0.5)
    r_ds = radius * w / ds
    sigma = SPREAD * r_ds
    soft_ds = _blur_ds(soft_ds, sigma)
    bloom_ds = _blur_ds(bloom_ds, sigma)

    soft = _resize(soft_ds, w, h)
    bloom = _resize(bloom_ds, w, h)

    out = soft * (1.0 - sharp) + full * sharp + bloom * boost
    return np.clip(out, 0.0, 1.0), bloom * boost


def load_src(path=SRC, max_w=1600):
    im = Image.open(path).convert("RGB")
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def metrics(full, out, bloom_add):
    """Objective measures of 'did it overdo it'."""
    g_in = np.abs(np.diff(full.mean(axis=2), axis=1)).mean() + np.abs(
        np.diff(full.mean(axis=2), axis=0)).mean()
    g_out = np.abs(np.diff(out.mean(axis=2), axis=1)).mean() + np.abs(
        np.diff(out.mean(axis=2), axis=0)).mean()
    newly_clipped = ((out >= 0.999) & (full < 0.999)).any(axis=2).mean()
    washed = (out.mean(axis=2) - full.mean(axis=2))
    return {
        "mean_abs_delta": float(np.abs(out - full).mean() * 255),
        "max_abs_delta": float(np.abs(out - full).max() * 255),
        "detail_retained": float(g_out / max(g_in, 1e-6)),
        "new_clip_pct": float(newly_clipped * 100),
        "bloom_mean": float(bloom_add.mean() * 255),
        "bloom_max": float(bloom_add.max() * 255),
        "mean_lift": float(washed.mean() * 255),
    }


def save(arr, path, width=None):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))
    if width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(path)
    return path


def label_tile(arr, label, tile_w=760):
    """Downscale + a caption bar, for contact sheets."""
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))
    im = im.resize((tile_w, round(im.height * tile_w / im.width)), Image.LANCZOS)
    bar = Image.new("RGB", (tile_w, 34), (16, 16, 18))
    from PIL import ImageDraw
    ImageDraw.Draw(bar).text((10, 10), label, fill=(255, 200, 140))
    out = Image.new("RGB", (tile_w, im.height + 34), (16, 16, 18))
    out.paste(bar, (0, 0))
    out.paste(im, (0, 34))
    return out
