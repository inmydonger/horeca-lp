"""
Bake the hero's contact shadows from each cut-out's own alpha.

For every piece it writes two images to public/img/shadow/hero/:
  <name>-contact.webp  tight, dark occlusion hugging the lower contour (where the piece meets the ground)
  <name>-soft.webp     soft cast shadow from the piece's footprint, pushed down-right (light is top-left)

Both share one box: the piece's box grown by a padding on every side. Prints the --x/--y/--w/--h
to paste into index.html for each (src/hero-drop.js reads the boxes back from layout).

Usage: python3 tools/bake-hero-shadows.py      (needs numpy + Pillow)
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public/img'
OUT = ROOT / 'public/img/shadow/hero'

PAD = 0.24          # of the box size, each side (room for the widest blur)
SCALE = 0.5         # bake at half the source resolution; shadows are soft anyway
INK = (58, 34, 22)  # warm umber, multiplied over cream

# name: (file, piece box in Figma visual units (x, y, w, h), footprint depth as a fraction of the
#        silhouette height: how far up from the lower contour still sits on the ground)
PIECES = {
    'lamb':       ('lamb-rack',   (268.91, 187.74, 590.67, 590.67), 0.42),  # frenched bones stand up
    'brisket':    ('brisket',     (762.62, 224.74, 418.45, 279.39), 0.75),
    'tenderloin': ('tenderloin',  (748.59, 413.55, 441.41, 294.7),  0.8),
    'tbone':      ('t-bone',      (38, 504.13, 461.82, 461.82),     0.75),
    'ribs':       ('short-ribs',  (291.87, 708.25, 470.75, 470.75), 0.7),
    'lemongrass': ('lemongrass',  (654.19, 636.81, 380.17, 253.87), 1.0),   # lies flat
    'rosemary':   ('rosemary',    (969.3, 723.56, 184.98, 184.98),  1.0),
    'pepper':     ('peppercorns', (617, 323, 116, 117),             0.9),
}


def blur(a, r):
    im = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8), 'L')
    return np.asarray(im.filter(ImageFilter.GaussianBlur(float(max(r, 0.1)))), dtype=np.float32) / 255


def shift(a, dx, dy):
    out = np.zeros_like(a)
    h, w = a.shape
    dx, dy = int(round(dx)), int(round(dy))
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def screen(*layers):
    acc = np.zeros_like(layers[0])
    for l in layers:
        acc = 1 - (1 - acc) * (1 - l)
    return acc


def bake(name, file, box, depth):
    src = Image.open(SRC / f'{file}.webp').convert('RGBA')
    w0, h0 = src.size
    w, h = int(w0 * SCALE), int(h0 * SCALE)
    # Room for the widest blur: PAD of the box, or ~56 screen px for small pieces.
    pad = max(PAD, 56 / box[2])
    px, py = int(w * pad), int(h * pad)
    W, H = w + 2 * px, h + 2 * py

    mask = np.zeros((H, W), np.float32)
    mask[py:py + h, px:px + w] = np.asarray(src.resize((w, h), Image.LANCZOS).split()[3], np.float32) / 255

    ys, xs = np.nonzero(mask > 0.5)
    sil_h = ys.max() - ys.min()
    unit = float(sil_h)  # every distance below is relative to the silhouette's height
    per_px = w / box[2]   # baked pixels per on-screen pixel (at the 1440 design width)

    def r(frac, min_screen_px):
        # Size relative to the piece, but never thinner than a few screen pixels, or small
        # pieces (peppercorns) lose their contact shadow entirely.
        return max(frac * unit, min_screen_px * per_px)

    # Lower contour per column, then how far each opaque pixel sits above it.
    rows = np.arange(H, dtype=np.float32)[:, None]
    bottom = np.where(mask > 0.5, rows, -1).max(axis=0).astype(np.float32)
    above = np.clip(bottom[None, :] - rows, 0, None)
    foot = mask * np.clip(1 - above / (depth * unit), 0, 1) ** 1.6  # what actually rests on the ground

    # Only darken at or below the lower contour, so the rim never reads as an outline up the sides.
    # Empty columns borrow the nearest real contour.
    cols = np.nonzero(bottom >= 0)[0]
    near_col = cols[np.abs(np.arange(W)[:, None] - cols[None, :]).argmin(axis=1)]
    floor = bottom[near_col]
    # Smooth the contour sideways and soften the gate, or column-to-column jitter in the cut-out's
    # edge shows up as vertical streaks in the rim.
    k = max(3, int(r(0.02, 4)) | 1)
    floor = np.convolve(np.pad(floor, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
    below = blur(np.clip((rows - (floor[None, :] - r(0.012, 1))) / r(0.025, 2), 0, 1), r(0.006, 1.5))

    # Contact: a thin dark occlusion under the contour, then a short falloff.
    c1 = blur(shift(mask, r(0.004, 0.5), r(0.01, 1.5)), r(0.009, 2.2)) * 0.85 * below
    c2 = blur(shift(foot, r(0.015, 1.5), r(0.03, 2.5)), r(0.025, 3)) * 0.5 * np.maximum(below, 0.35)
    contact = screen(c1, c2)

    # Soft: the footprint cast down-right and blurred wide, plus a faint large ambient pool.
    s1 = blur(shift(foot, r(0.07, 4), r(0.07, 4)), r(0.05, 5)) * 0.42
    s2 = blur(shift(foot, r(0.13, 8), r(0.13, 8)), r(0.13, 12)) * 0.26
    soft = screen(s1, s2)

    OUT.mkdir(parents=True, exist_ok=True)
    for kind, a in (('contact', contact), ('soft', soft)):
        rgba = np.zeros((H, W, 4), np.uint8)
        rgba[..., :3] = INK
        rgba[..., 3] = np.clip(a * 255, 0, 255).astype(np.uint8)
        Image.fromarray(rgba, 'RGBA').save(OUT / f'{name}-{kind}.webp', 'WEBP', quality=82, method=6)

    x, y, bw, bh = box
    gx, gy = bw * px / w, bh * py / h
    print(f'{name:11s} --x:{x - gx:.2f};--y:{y - gy:.2f};--w:{bw + 2 * gx:.2f};--h:{bh + 2 * gy:.2f}')


if __name__ == '__main__':
    for n, (f, b, d) in PIECES.items():
        bake(n, f, b, d)
