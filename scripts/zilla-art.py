#!/usr/bin/env python3
"""The Zilla pictures in public/buzzy/zillas, made from the owner's starter picture.

The owner sent one picture with four Zilla heads (2026-11-21): the bee with antennae,
the horned one, the bunny and the frog. This script cuts it into four transparent
pictures (the empty column x=627 and empty row y=596 of the 1254 px source separate the
four heads, so nothing is cut), puts every head in the same square window on the same
chin line (so every face is the same size), and makes the colour versions:

    <creature>.webp          the owner's own art, as drawn
    <creature>-<colour>.webp the same head with the hue of its coloured parts moved
                             (white, black and grey parts stay as drawn)

The colour versions are stand-ins. The owner is having real colour Zillas drawn
(Astra, through the Slack bridge); a real picture takes the place of a stand-in by
using the same file name, and nothing else changes.

Heads that come as a picture of their own (2026-11-23: the owner's Code Monkey, a
monkey head in the same style, sent on its own) are listed in SINGLES: each is cut to
its outline, scaled to the width the frog has (the widest of the four) and stood on the
same chin line, so it sits in the strip at the same size as the others.

Run:  python3 -I scripts/zilla-art.py <output folder>
Needs Pillow (with WebP). The source pictures are not in the repository.
"""
import sys, os, json
sys.path.insert(0, "/Users/saveon/Library/Python/3.9/lib/python/site-packages")
from PIL import Image, ImageChops

SRC = "/Users/saveon/Documents/BeeZilla art/zillas-starter-4.webp"
OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
SIZE = 256
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGBA")
W, H = im.size
SX, SY = 627, 596   # the empty column and empty row that separate the four heads
quads = {
    "bee":   (0, 0, SX, SY),
    "bull":  (SX, 0, W, SY),
    "bunny": (0, SY, SX, H),
    "frog":  (SX, SY, W, H),
}
# base hue (degrees) of each creature's coloured parts, measured from the picture
BASE_HUE = {"bee": 40, "bull": 20, "bunny": 21, "frog": 65}
# the colours a Zilla comes in: name -> target hue in degrees
COLORS = {
    "red": 358, "orange": 24, "yellow": 46, "lime": 84, "green": 125, "teal": 168,
    "sky": 200, "blue": 224, "indigo": 252, "purple": 278, "magenta": 306, "pink": 336,
}

# one window size for all four, aligned on the chin, so every face is the same size
boxes = {}
for name, box in quads.items():
    q = im.crop(box)
    a = q.getchannel("A").point(lambda p: 255 if p > 24 else 0)
    boxes[name] = (q, a.getbbox())
S = int(max(max(bb[2]-bb[0], bb[3]-bb[1]) for _, bb in boxes.values()) * 1.07)

def window(name):
    q, bb = boxes[name]
    cx = (bb[0] + bb[2]) / 2
    bottom = bb[3] + int(S * 0.035)
    x0 = int(round(cx - S / 2)); y0 = bottom - S
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # paste the part of the quad that falls inside the window (pads with transparency)
    sx0, sy0 = max(x0, 0), max(y0, 0)
    sx1, sy1 = min(x0 + S, q.size[0]), min(y0 + S, q.size[1])
    canvas.paste(q.crop((sx0, sy0, sx1, sy1)), (sx0 - x0, sy0 - y0))
    return canvas

def shifted(img, delta_deg):
    """Move the hue of the coloured parts only; white, black and grey stay as they are."""
    rgb = img.convert("RGB")
    a = img.getchannel("A")
    h, s, v = rgb.convert("HSV").split()
    d = int(round(delta_deg * 255.0 / 360.0)) % 256
    h2 = h.point(lambda x: (x + d) & 255)
    # 0 below saturation ~0.13, 255 above ~0.30, a ramp between
    mask = s.point(lambda x: 0 if x < 34 else 255 if x > 77 else int((x - 34) * 255 / 43))
    h3 = Image.composite(h2, h, mask)
    out = Image.merge("HSV", (h3, s, v)).convert("RGB")
    out.putalpha(a)
    return out

def save(img, path):
    small = img.resize((SIZE, SIZE), Image.LANCZOS)
    small.save(path, "WEBP", quality=88, alpha_quality=100, method=6)
    return os.path.getsize(path)

# Heads that arrive as their own picture: file in the art folder, base hue of the coloured
# parts (measured: the monkey's brown fur and ear cups sit at 21-31 degrees, median 23).
SINGLES = {"monkey": ("/Users/saveon/Documents/BeeZilla art/code-monkey.png", 23)}
# Where the four heads above land in a SIZE x SIZE picture: the frog (the widest) spans
# 227 px and every chin sits on y = 247. A single head is fitted to the same.
FIT_W, CHIN = 227 / 256, 247 / 256

def single(path):
    pic = Image.open(path).convert("RGBA")
    bb = pic.getchannel("A").point(lambda p: 255 if p > 24 else 0).getbbox()
    head = pic.crop(bb)
    scale = min(FIT_W * SIZE * 4 / head.size[0], CHIN * SIZE * 4 / head.size[1])
    big = head.resize((max(1, round(head.size[0] * scale)), max(1, round(head.size[1] * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE * 4, SIZE * 4), (0, 0, 0, 0))
    canvas.paste(big, ((SIZE * 4 - big.size[0]) // 2, round(CHIN * SIZE * 4) - big.size[1]), big)
    return canvas

total = 0
report = {}
for name in quads:
    base = window(name)
    total += save(base, os.path.join(OUT, f"{name}.webp"))
    for cname, hue in COLORS.items():
        delta = ((hue - BASE_HUE[name] + 180) % 360) - 180
        v = shifted(base, delta)
        total += save(v, os.path.join(OUT, f"{name}-{cname}.webp"))
    report[name] = {"window": S, "bbox": boxes[name][1]}
for name, (path, base_hue) in SINGLES.items():
    if not os.path.exists(path):
        print("skipped", name, "(no picture at", path + ")")
        continue
    base = single(path)
    total += save(base, os.path.join(OUT, f"{name}.webp"))
    for cname, hue in COLORS.items():
        delta = ((hue - base_hue + 180) % 360) - 180
        total += save(shifted(base, delta), os.path.join(OUT, f"{name}-{cname}.webp"))
    report[name] = {"source": os.path.basename(path)}
print("window", S, "files", len(os.listdir(OUT)), "total KB", total // 1024)
json.dump(report, open(os.path.join(OUT, "_report.json"), "w"))
