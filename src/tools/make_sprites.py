"""Build src/sprites.js (CT.sprites) and src/portraits.js (CT.portraitArt) from the painted art.

python tools/make_sprites.py [--art ../art] [--height 512] [--quality 82]      (default: art/sprites/<id>_<a>.png, pre-cut RGBA)
python tools/make_sprites.py --legacy [--src DIR]                             (the original silhouette cut from raw paintings)

Cut: the painted frame is clipped by its silhouette guide with the local chroma-key cleanup from the sprite
pipeline (painted_sprites/sprite.py), feathered ~1.5 px. The painting is kept as is: no posterise, no dither,
no outline. Colours are bled past the edge so mipmaps stay clean. Output: WebP (alpha) data URIs + anchors.
"""
import argparse, base64, io, json, os
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--src", default=r"C:\Users\John\AppData\Local\Temp\painted_sprites")
ap.add_argument("--height", type=int, default=512)
ap.add_argument("--quality", type=int, default=82)
ap.add_argument("--art", default=os.path.join(os.path.dirname(HERE), "art"))
ap.add_argument("--legacy", action="store_true")
a = ap.parse_args()
HEROES = ["kaela", "nyx", "vesna", "selene"]
ANGLES = ["a0", "a35", "a90", "a180"]
# dialog portraits used by npcs.js (256x320 WebP); villagers map onto the generic painted townsfolk
PORTRAITS = ["kaela", "nyx", "vesna", "selene", "bram", "oldmag", "villager_m", "villager_f", "pilgrim", "militia", "merchant"]

# best painted seed per angle (the 3/4 is the one in kaela_sheet.png)
PICKS = {"kaela": {"a0": "kaela_a0_s11_base", "a35": "kaela_a35_s11", "a90": "kaela_a90_s22", "a180": "kaela_a180_s11"}}
HEIGHT_M = {"kaela": 1.83, "nyx": 1.83, "vesna": 1.83, "selene": 1.83}   # the heroine sculpts all stand about 1.83 m


def precut(path):
    """A painted frame that is already cut (RGBA): crop to the alpha, anchor at the feet, bleed colours, scale."""
    im = Image.open(path).convert("RGBA"); arr = np.asarray(im).astype(np.float32) / 255
    A = arr[..., 3]; P = arr[..., :3]; M = A > 0.5
    ys, xs = np.where(M)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    fy = int(y1 - (y1 - y0) * 0.06); fx = xs[ys >= fy].mean()
    inner = A > 0.9
    idx = ndimage.distance_transform_edt(~inner, return_distances=False, return_indices=True)
    Pb = P.copy(); Pb[~inner] = P[idx[0], idx[1]][~inner]
    pad = 6
    Y0, X0, Y1, X1 = max(0, y0 - pad), max(0, x0 - pad), min(M.shape[0], y1 + pad), min(M.shape[1], x1 + pad)
    sc = a.height / (y1 - y0)
    w, h = max(1, round((X1 - X0) * sc)), max(1, round((Y1 - Y0) * sc))
    rgba = np.dstack([Pb[Y0:Y1, X0:X1], A[Y0:Y1, X0:X1]])
    out = Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), "RGBA").resize((w, h), Image.LANCZOS)
    return out, {"w": w, "h": h, "top": (y0 - Y0) / (Y1 - Y0), "bottom": (y1 - Y0) / (Y1 - Y0), "ax": (fx - X0) / (X1 - X0)}


def cut(paint, sil):
    P = np.asarray(Image.open(paint).convert("RGB")).astype(np.float32) / 255
    M = np.asarray(Image.open(sil).convert("L")) > 127
    # local chroma key near the silhouette edge (same as sprite.py): drop pixels matching the painted background
    ring = ndimage.binary_dilation(M, iterations=30) & ~ndimage.binary_dilation(M, iterations=4)
    bg = P[ring][::7]
    rng = np.random.default_rng(0); cent = bg[rng.choice(len(bg), 12, replace=False)]
    for _ in range(8):
        lab = ((bg[:, None] - cent[None]) ** 2).sum(-1).argmin(1)
        cent = np.array([bg[lab == k].mean(0) if (lab == k).any() else cent[k] for k in range(len(cent))])
    edge = M & ~ndimage.binary_erosion(M, iterations=9)
    ey, ex = np.where(edge)
    d = np.sqrt(((P[ey, ex][:, None] - cent[None]) ** 2).sum(-1)).min(1)
    kill = np.zeros_like(M); kill[ey[d < 0.075], ex[d < 0.075]] = True
    M = M & ~kill
    # sky fringe: in a thin edge band, drop bluish pixels (the palette has no blue except the painted sky), then erode 2 px
    band = M & ~ndimage.binary_erosion(M, iterations=6)
    blue = (P[..., 2] > P[..., 0] + 0.06) & (P[..., 2] > P[..., 1] - 0.02)
    M = M & ~(band & blue)
    M = ndimage.binary_erosion(M, iterations=2)
    M = ndimage.binary_opening(M, iterations=1)
    lab, n = ndimage.label(M)
    if n > 1:
        sz = ndimage.sum(M, lab, range(1, n + 1)); M = np.isin(lab, 1 + np.where(sz >= max(sz.max() * 0.03, 400))[0])
    # bleed the painted colour outward so the transparent border (and its mips) carries edge colours, not background
    inner = ndimage.binary_erosion(M, iterations=2)
    idx = ndimage.distance_transform_edt(~inner, return_distances=False, return_indices=True)
    Pb = P.copy(); Pb[~inner] = P[idx[0], idx[1]][~inner]
    ys, xs = np.where(M)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    # feet anchor: centre of the lowest 6% of the silhouette rows
    fy = int(y1 - (y1 - y0) * 0.06); fx = xs[ys >= fy].mean()
    pad = 6
    Y0, X0, Y1, X1 = max(0, y0 - pad), max(0, x0 - pad), min(M.shape[0], y1 + pad), min(M.shape[1], x1 + pad)
    A = ndimage.gaussian_filter(M.astype(np.float32), 1.5)[Y0:Y1, X0:X1]
    C = Pb[Y0:Y1, X0:X1]
    sc = a.height / (y1 - y0)
    w, h = max(1, round((X1 - X0) * sc)), max(1, round((Y1 - Y0) * sc))
    rgba = np.dstack([C, A]); im = Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), "RGBA").resize((w, h), Image.LANCZOS)
    meta = {"w": w, "h": h, "top": (y0 - Y0) / (Y1 - Y0), "bottom": (y1 - Y0) / (Y1 - Y0), "ax": (fx - X0) / (X1 - X0)}
    return im, meta


def webp(im, q):
    buf = io.BytesIO(); im.save(buf, "WEBP", quality=q, method=6, alpha_quality=90); return buf.getvalue()


out = {}
total = 0
jobs = PICKS.items() if a.legacy else [(k, {g: None for g in ANGLES}) for k in HEROES]
for kind, picks in jobs:
    frames = {}
    for key, name in picks.items():
        if a.legacy: im, meta = cut(os.path.join(a.src, "paint", name + ".png"), os.path.join(a.src, "guides", f"{kind}_{key}_sil.png"))
        else: im, meta = precut(os.path.join(a.art, "sprites", f"{kind}_{key}.png"))
        b = webp(im, a.quality); total += len(b)
        meta["src"] = "data:image/webp;base64," + base64.b64encode(b).decode()
        frames[key] = meta
        im.save(os.path.join(os.environ.get("TEMP", "."), f"sprite_{kind}_{key}.png"))
        print(f"{kind} {key}: {meta['w']}x{meta['h']} {len(b) // 1024} KB  feet ax {meta['ax']:.2f}")
    out[kind] = {"height": HEIGHT_M[kind], "frames": frames}

js = ("// ─── SPRITES: painted character frames (generated by tools/make_sprites.py; do not edit) ───\n"
      "window.CT = window.CT || {};\n"
      "CT.sprites = " + json.dumps(out, separators=(",", ":")) + ";\n")
open(os.path.join(HERE, "sprites.js"), "w", encoding="utf8").write(js)
print(f"wrote sprites.js  {len(js) // 1024} KB  (images {total // 1024} KB)")

if not a.legacy:
    pout, ptot = {}, 0
    for pid in PORTRAITS:
        src = os.path.join(a.art, "portraits", pid + ".png")
        if not os.path.exists(src): print("missing portrait", pid); continue
        im = Image.open(src).convert("RGB").resize((256, 320), Image.LANCZOS)
        b = webp(im, 80); ptot += len(b)
        pout[pid] = "data:image/webp;base64," + base64.b64encode(b).decode()
    pj = ("// ─── PORTRAITS: painted dialog portraits, 256x320 (generated by tools/make_sprites.py; do not edit) ───\n"
          "window.CT = window.CT || {};\n"
          "CT.portraitArt = " + json.dumps(pout, separators=(",", ":")) + ";\n")
    open(os.path.join(HERE, "portraits.js"), "w", encoding="utf8").write(pj)
    print(f"wrote portraits.js  {len(pj) // 1024} KB  ({len(pout)} portraits, {ptot // 1024} KB)")
