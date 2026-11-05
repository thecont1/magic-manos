import sys, json
import numpy as np
sys.path.insert(0, "/Users/home/DEV/tools/manorama/.work")
from dreamy_ref import load_src, dreamy, metrics

full = load_src(max_w=100000)
H, W = full.shape[:2]

# regions as (x0, y0, x1, y1) fractions of the frame
REGIONS = {
    "phone-specular": (0.78, 0.63, 0.90, 0.72),
    "sleeve-white":   (0.72, 0.76, 0.86, 0.86),
    "sky":            (0.52, 0.03, 0.70, 0.14),
    "cheek-skin":     (0.09, 0.30, 0.20, 0.40),
    "forehead-skin":  (0.13, 0.17, 0.24, 0.24),
    "red-shirt":      (0.05, 0.70, 0.25, 0.85),
    "temple-stone":   (0.58, 0.20, 0.70, 0.34),
    "bougainvillea":  (0.72, 0.50, 0.86, 0.60),
}

def slices(frac):
    x0, y0, x1, y1 = frac
    return (slice(int(y0 * H), int(y1 * H)), slice(int(x0 * W), int(x1 * W)))

CANDS = []
for r in (0.008, 0.012, 0.016):
    for t in (0.90, 0.92, 0.94):
        for s in (0.90, 0.94):
            for b in (0.30, 0.45, 0.60):
                CANDS.append((r, t, s, b))

rows = []
for r, t, s, b in CANDS:
    out, bloom = dreamy(full, r, t, s, b)
    m = metrics(full, out, bloom)
    row = {"r": r, "t": t, "s": s, "b": b,
           "dD": round(m["mean_abs_delta"], 2),
           "det": round(m["detail_retained"], 3),
           "clip%": round(m["new_clip_pct"], 3)}
    d = (out - full) * 255.0
    for name, fr in REGIONS.items():
        sl = slices(fr)
        row[name] = round(float(np.abs(d[sl]).mean()), 2)
    rows.append(row)

json.dump(rows, open("/Users/home/DEV/tools/manorama/.work/sweep-02.json", "w"), indent=1)

# Rank: glow must be concentrated on speculars (phone/sleeve/sky),
# quiet on skin and midtones, and no new clipping.
def score(row):
    spec = (row["phone-specular"] + row["sleeve-white"] + row["sky"]) / 3
    skin = (row["cheek-skin"] + row["forehead-skin"]) / 2
    ratio = spec / max(skin, 0.05)
    return (ratio * 3.0 - row["clip%"] * 4.0 - abs(row["det"] - 0.94) * 20.0
            - abs(row["dD"] - 2.4) * 1.5)

for row in rows:
    row["score"] = round(score(row), 3)

rows.sort(key=lambda x: -x["score"])
hdr = ["r", "t", "s", "b", "dD", "det", "clip%", "phone-specular", "sleeve-white",
       "sky", "cheek-skin", "forehead-skin", "red-shirt", "temple-stone", "bougainvillea", "score"]
print(" | ".join(f"{k}" for k in hdr))
for row in rows[:24]:
    print(" | ".join(str(row[k]) for k in hdr))
