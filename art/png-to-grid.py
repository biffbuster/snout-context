#!/usr/bin/env python3
"""Turn a pixel-art PNG into a Snout frame grid.

Samples the PNG on a fixed grid, snaps each cell to the nearest palette
color from art/snout.frames.txt, and prints a frame block you paste into
that file. Light near-white background becomes "." (transparent).

Usage:
  python3 art/png-to-grid.py path/to/frame.png --name wave
  python3 art/png-to-grid.py path/to/frame.png --cols 20 --rows 24

Needs Pillow: pip install pillow
"""
import argparse
import pathlib
from collections import Counter

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRAMES = ROOT / "art" / "snout.frames.txt"


def load_palette():
    palette, on = {".": (255, 255, 255)}, False
    for line in FRAMES.read_text(encoding="utf-8").splitlines():
        if line.strip() == "palette:":
            on = True
            continue
        if on:
            parts = line.split()
            if len(parts) < 2 or not parts[1].startswith("#"):
                if line.startswith("=="):
                    break
                continue
            h = parts[1].lstrip("#")
            palette[parts[0]] = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    return palette


def bbox(im, bg_threshold=235):
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if min(px[x, y][:3]) < bg_threshold:
                xs.append(x)
                ys.append(y)
    return min(xs), max(xs) + 1, min(ys), max(ys) + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("png")
    ap.add_argument("--cols", type=int, default=20)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--name", default="new")
    args = ap.parse_args()

    palette = load_palette()
    im = Image.open(args.png).convert("RGB")
    x0, x1, y0, y1 = bbox(im)
    cw, ch = (x1 - x0) / args.cols, (y1 - y0) / args.rows

    def nearest(c):
        return min(palette, key=lambda k: sum((a - b) ** 2 for a, b in zip(c, palette[k])))

    print(f"== {args.name}")
    for r in range(args.rows):
        line = ""
        for c in range(args.cols):
            votes = Counter()
            for dy in range(4):
                for dx in range(4):
                    x = int(x0 + cw * (c + 0.3 + 0.4 * dx / 3))
                    y = int(y0 + ch * (r + 0.3 + 0.4 * dy / 3))
                    votes[nearest(im.getpixel((x, y)))] += 1
            line += votes.most_common(1)[0][0]
        print(line)


if __name__ == "__main__":
    main()
