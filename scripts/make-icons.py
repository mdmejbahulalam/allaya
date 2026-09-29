#!/usr/bin/env python3
"""Draws Allaya's icon (a violet-to-blue rounded square with a white sparkle) and writes the sizes the installer, the
window and the tray need into apps/desktop/build/. Run: python3 scripts/make-icons.py  (needs Pillow)."""
import math, pathlib
from PIL import Image, ImageDraw, ImageFilter

out = pathlib.Path(__file__).resolve().parent.parent / "apps/desktop/build"
out.mkdir(parents=True, exist_ok=True)
S = 1024

def gradient(size):
    top, bottom = (124, 92, 255), (56, 152, 255)  # accent violet -> blue
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.35 + y * 0.65) / size
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img

def sparkle(draw, cx, cy, r, fill):
    # A four-point star: an astroid (concave sides), with the tips slightly softened.
    pts = []
    for i in range(0, 360, 2):
        a = math.radians(i)
        rr = r * (abs(math.cos(a)) ** (2 / 3) + abs(math.sin(a)) ** (2 / 3)) ** (-1.5)
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    draw.polygon(pts, fill=fill)

base = gradient(S).convert("RGBA")
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255)
star = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(star)
sparkle(d, S * 0.45, S * 0.55, S * 0.34, (255, 255, 255, 255))
sparkle(d, S * 0.75, S * 0.26, S * 0.13, (255, 255, 255, 235))
glow = star.filter(ImageFilter.GaussianBlur(S * 0.02))
base = Image.alpha_composite(base, Image.new("RGBA", (S, S), (0, 0, 0, 0)))
base = Image.alpha_composite(base, glow)
base = Image.alpha_composite(base, star)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(base, (0, 0), mask)

icon.save(out / "icon.png")
sizes = [16, 24, 32, 48, 64, 128, 256]
icon.resize((256, 256), Image.LANCZOS).save(out / "icon.ico", sizes=[(s, s) for s in sizes])
icon.resize((32, 32), Image.LANCZOS).save(out / "tray.png")
icon.resize((64, 64), Image.LANCZOS).save(out / "tray@2x.png")
print("wrote", sorted(p.name for p in out.iterdir()))
