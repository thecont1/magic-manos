import sys
import numpy as np
sys.path.insert(0, "/Users/home/DEV/tools/manorama/.work")
from dreamy_ref import load_src, dreamy
from PIL import Image
from scipy.ndimage import gaussian_filter1d, gaussian_filter

ON = "/Users/home/.minimax/v2/assets/2026/11/04/20-52-40-128-asset_20261104-205240-128_d33cb0dbd217_529ba189-browser-screenshot.png"
OFF = "/Users/home/.minimax/v2/assets/2026/11/04/20-52-59-424-asset_20261104-205259-424_251a6efd2fe0_985855f2-browser-screenshot.png"

on = np.asarray(Image.open(ON).convert("RGB"), dtype=np.float32)
off = np.asarray(Image.open(OFF).convert("RGB"), dtype=np.float32)
X_L, Y_TOP = 45, 263          # canvas origin in device px (DPR 2, 100% zoom)

def crop(a):
    return a[Y_TOP:, X_L:]

d_dev = crop(on) - crop(off)
# device px -> source px (canvas is 1 source px per CSS px, DPR 2)
h_src = d_dev.shape[0] // 2
w_src = d_dev.shape[1] // 2
d_src = np.asarray(Image.fromarray(np.clip(d_dev + 128, 0, 255).astype(np.uint8)).resize(
    (w_src, h_src), Image.LANCZOS), dtype=np.float32) - 128.0
print(f"1:1 comparison region: {w_src}x{h_src} source px  (device crop {d_dev.shape})")

full = load_src(max_w=100000)
filt, _ = dreamy(full, 0.018, 0.95, 0.92, 0.38)
ref = (filt - full) * 255.0
ref_crop = ref[:h_src, :w_src]

def corr(a, b):
    a = a.reshape(-1).astype(np.float64); b = b.reshape(-1).astype(np.float64)
    a -= a.mean(); b -= b.mean()
    return float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum()))

print(f"\nfull-band corr (browser vs reference): {corr(d_src, ref_crop):.4f}")
print(f"  |browser| mean {np.abs(d_src).mean():.3f}/255   |ref| mean {np.abs(ref_crop).mean():.3f}/255")

# low-frequency (the bloom signature) — blur both at 15 source px
lb = gaussian_filter(d_src.mean(axis=2), 15)
lr = gaussian_filter(ref_crop.mean(axis=2), 15)
print(f"low-frequency (sigma 15px) corr: {corr(lb, lr):.4f}")
print(f"  |browser| mean {np.abs(lb).mean():.3f}   |ref| mean {np.abs(lr).mean():.3f}   "
      f"ratio {np.abs(lb).mean() / max(np.abs(lr).mean(), 1e-6):.2f}")

# control: the OLD recipe should correlate far worse
old, _ = dreamy(full, 0.006, 0.75, 0.5, 0.6)
ref_old = (old - full) * 255.0
lo = gaussian_filter(ref_old[:h_src, :w_src].mean(axis=2), 15)
print(f"low-frequency corr vs OLD recipe (control): {corr(lb, lo):.4f}")

# amplified comparison image: harness change (left) vs reference change (right)
def amp(d, gain=10):
    return np.clip(0.5 + d * gain / 255.0, 0, 1)

a1 = amp(d_src.mean(axis=2))
a2 = amp(ref_crop.mean(axis=2))
sheet = np.concatenate([a1, np.ones((a1.shape[0], 4), np.float32), a2], axis=1)
Image.fromarray((sheet * 255).astype(np.uint8)).save(
    "/Users/home/DEV/tools/manorama/.work/verify-1to1.png")
print("\nwrote verify-1to1.png (left: harness WebGL change x10, right: reference change x10)")
