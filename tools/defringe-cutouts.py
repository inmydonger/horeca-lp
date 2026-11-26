"""
Remove the light halo that background removal left around the cut-outs.

Reads the untouched originals from tools/cutouts-src/ and writes cleaned copies to public/img/:
  1. Colour: pixels within a few px of the edge are re-coloured from the piece's own interior
     (colours are grown outward from ~4px inside), strongest at the rim, fading inward.
  2. Edge: the hard 0/255 alpha is pulled in by ~1px and given a soft anti-aliased edge, so the
     last bright ring is gone and the piece sits on its contact shadow without a white outline.

Run from the repo root:  python3 tools/defringe-cutouts.py   (needs numpy + Pillow)
Then re-bake the hero shadows: python3 tools/bake-hero-shadows.py
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools/cutouts-src'
OUT = ROOT / 'public/img'

FILES = ['lamb-rack', 'brisket', 't-bone', 'tenderloin', 'short-ribs', 'lemongrass', 'rosemary', 'peppercorns']
# Re-colour weight by ring (1 = outermost px). Ring 1 is mostly cut away by the alpha trim anyway.
RING_WEIGHT = [1.0, 0.85, 0.55, 0.25]
CORE = len(RING_WEIGHT) + 1  # colours are trusted from this ring inward


def erode(mask, k):
    """Binary erosion by k px (square)."""
    if k <= 0:
        return mask
    im = Image.fromarray((mask * 255).astype(np.uint8), 'L')
    return np.asarray(im.filter(ImageFilter.MinFilter(2 * k + 1))) > 127


def grow_colours(rgb, known, steps):
    """Push known colours outward one px per step (3×3 average of known neighbours)."""
    rgb = rgb.copy()
    known = known.copy()
    h, w = known.shape
    for _ in range(steps):
        acc = np.zeros_like(rgb)
        cnt = np.zeros((h, w), np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                k = np.roll(np.roll(known, dy, 0), dx, 1)
                c = np.roll(np.roll(rgb, dy, 0), dx, 1)
                acc += c * k[..., None]
                cnt += k
        new = (~known) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][:, None]
        known |= new
    return rgb


def defringe(name):
    src = Image.open(SRC / f'{name}.webp').convert('RGBA')
    a = np.asarray(src, np.float32)
    rgb, mask = a[..., :3], a[..., 3] > 127

    # Ring index of every opaque pixel (1 = outermost), capped at CORE.
    ring = np.zeros(mask.shape, np.int32)
    prev = mask
    for k in range(1, CORE + 1):
        inner = erode(mask, k)
        ring[prev & ~inner] = k
        prev = inner
    ring[prev] = CORE + 1

    core = ring > CORE
    filled = grow_colours(np.where(core[..., None], rgb, 0), core, CORE + 6)

    w = np.zeros(mask.shape, np.float32)
    for i, wt in enumerate(RING_WEIGHT, start=1):
        w[ring == i] = wt
    out_rgb = rgb * (1 - w[..., None]) + filled * w[..., None]
    out_rgb[~mask] = filled[~mask]  # transparent px carry edge colour too, so scaling never bleeds white

    # Alpha: trim ~1px and anti-alias the new edge.
    trimmed = Image.fromarray((erode(mask, 1) * 255).astype(np.uint8), 'L')
    alpha = np.asarray(trimmed.filter(ImageFilter.GaussianBlur(0.8)), np.float32)
    alpha = np.clip((alpha - 64) * (255 / 191), 0, 255)  # keep the core fully opaque, fade only the rim

    out = np.dstack([np.clip(out_rgb, 0, 255), alpha]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(OUT / f'{name}.webp', 'WEBP', quality=86, method=6, exact=True)
    print(f'{name:12s} ok')


if __name__ == '__main__':
    for f in FILES:
        defringe(f)
