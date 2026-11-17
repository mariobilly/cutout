"""Generates build/icon.png + build/icon.ico for CUTOUT.

A paper tile with a torn halftone photo scrap, a neon-lime cut-out figure (black outline, white sticker
border, "A" label), a red marker loop and a strip of masking tape. Drawn at 2048 px, downsampled.
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

S = 2048
K = S / 1024  # design coordinates are 1024-based
OUT = Path(__file__).parent
random.seed(11)


def P(x, y):
    return (x * K, y * K)


def noise_line(a, b, amp, step, jag=0.35):
    """Points from a to b with a ragged perpendicular displacement (torn edge)."""
    (ax, ay), (bx, by) = a, b
    length = math.hypot(bx - ax, by - ay)
    n = max(2, int(length / step))
    nx, ny = -(by - ay) / length, (bx - ax) / length
    pts = []
    off = 0.0
    for i in range(n):
        t = i / n
        off = off * 0.55 + random.uniform(-1, 1) * amp * jag + random.uniform(-1, 1) * amp * 0.15
        off = max(-amp, min(amp, off))
        pts.append((ax + (bx - ax) * t + nx * off, ay + (by - ay) * t + ny * off))
    return pts


def torn_poly(corners, amp, step):
    pts = []
    for i in range(len(corners)):
        pts += noise_line(corners[i], corners[(i + 1) % len(corners)], amp, step)
    return pts


def rot_rect(cx, cy, w, h, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [(cx + x * c - y * s, cy + x * s + y * c) for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]


def mask_poly(pts):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def dilate(mask, r):
    """Soft dilation by ~r px: blur then threshold low."""
    return mask.filter(ImageFilter.GaussianBlur(r)).point(lambda v: 255 if v > 18 else 0).filter(ImageFilter.GaussianBlur(1.2))


def shadow_of(mask, blur, dx, dy, alpha):
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    a = ImageChops.offset(mask, int(dx), int(dy)).filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * alpha))
    sh.putalpha(a)
    return sh


def solid(color, mask):
    layer = Image.new("RGBA", (S, S), color)
    layer.putalpha(ImageChops.multiply(mask, Image.new("L", (S, S), color[3] if len(color) > 3 else 255)))
    return layer


# --- paper tile ---------------------------------------------------------------
img = Image.new("RGBA", (S, S), (238, 234, 225, 255))
grain = Image.effect_noise((S, S), 18).filter(ImageFilter.GaussianBlur(1.1))
blotch = Image.effect_noise((S // 32, S // 32), 40).resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(24))
tex = Image.blend(grain, blotch.point(lambda v: 128 + (v - 128) * 0.35), 0.4)  # mean ~128, gentle mottling
paper_rgb = Image.merge("RGB", [ImageChops.add(Image.new("L", (S, S), base), tex, offset=-128) for base in (236, 232, 222)])
img = paper_rgb.convert("RGBA")
fib = ImageDraw.Draw(img, "RGBA")
for _ in range(900):
    x, y = random.uniform(0, S), random.uniform(0, S)
    a = random.uniform(0, math.pi * 2)
    l = random.uniform(8, 40) * K
    fib.line([(x, y), (x + math.cos(a) * l, y + math.sin(a) * l)], fill=(70, 60, 50, random.randint(10, 26)), width=1)

# --- torn halftone photo scrap ----------------------------------------------------
scrap_rect = rot_rect(*P(470, 560), 640 * K, 720 * K, -9)
scrap_poly = torn_poly(scrap_rect, 9 * K, 7 * K)
rim_poly = torn_poly(rot_rect(*P(470, 560), 664 * K, 744 * K, -9), 12 * K, 6 * K)
rim_mask = mask_poly(rim_poly)
scrap_mask = mask_poly(scrap_poly)
img = Image.alpha_composite(img, shadow_of(rim_mask, 22 * K, 8 * K, 16 * K, 0.45))
img = Image.alpha_composite(img, solid((250, 249, 245, 255), rim_mask))

# halftone of a soft diagonal light falling on a wall + a dark blob (abstract "photo")
ht = Image.new("RGBA", (S, S), (226, 224, 218, 255))
hd = ImageDraw.Draw(ht)
cell = 22 * K
for gy in range(int(S / cell) + 2):
    for gx in range(int(S / cell) + 2):
        cx, cy = gx * cell + (cell / 2 if gy % 2 else 0), gy * cell
        u, v = cx / S, cy / S
        dark = 0.25 + 0.55 * (u * 0.6 + v * 0.7) / 1.3
        dark += 0.35 * math.exp(-(((u - 0.35) / 0.16) ** 2 + ((v - 0.42) / 0.22) ** 2))
        dark = max(0.05, min(0.95, dark))
        r = cell * 0.62 * math.sqrt(dark)
        hd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(24, 24, 26, 255))
ht.putalpha(scrap_mask)
img = Image.alpha_composite(img, ht)

# --- the cut-out figure ---------------------------------------------------------------
fig = Image.new("L", (S, S), 0)
fd = ImageDraw.Draw(fig)


def limb(points, w):
    pts = [P(*p) for p in points]
    fd.line(pts, fill=255, width=int(w * K), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = w * K / 2
        fd.ellipse([x - r, y - r, x + r, y + r], fill=255)


hx, hy, hr = 600, 268, 74
fd.ellipse([P(hx - hr, hy - hr * 1.08), P(hx + hr, hy + hr * 1.08)], fill=255)
limb([(596, 330), (592, 372)], 70)  # neck
fd.polygon([P(500, 380), P(690, 372), P(676, 520), P(656, 640), P(540, 646), P(518, 520)], fill=255)  # torso
limb([(520, 400), (468, 520), (424, 628)], 64)  # back arm
limb([(668, 400), (742, 500), (800, 548)], 62)  # front arm
limb([(566, 630), (520, 760), (462, 880)], 82)  # back leg
limb([(632, 630), (700, 752), (770, 852)], 80)  # front leg
limb([(462, 880), (408, 892)], 46)  # feet
limb([(770, 852), (826, 842)], 46)
fig = fig.filter(ImageFilter.GaussianBlur(7 * K)).point(lambda v: 255 if v > 120 else 0).filter(ImageFilter.GaussianBlur(1.0))

ink = dilate(fig, 16 * K)  # black outline
sticker = dilate(ink, 22 * K)  # white sticker border
img = Image.alpha_composite(img, shadow_of(sticker, 20 * K, 6 * K, 14 * K, 0.5))
img = Image.alpha_composite(img, solid((255, 255, 255, 255), sticker))
img = Image.alpha_composite(img, solid((14, 14, 16, 255), ink))
img = Image.alpha_composite(img, solid((212, 242, 58, 255), fig))

# "A" label on the torso
font = None
for f in ("ariblk.ttf", "arialbd.ttf", "segoeuib.ttf"):
    try:
        font = ImageFont.truetype(f"C:/Windows/Fonts/{f}", int(120 * K))
        break
    except OSError:
        pass
d = ImageDraw.Draw(img)
bb = d.textbbox((0, 0), "A", font=font)
tx, ty = P(596, 512)
d.text((tx - (bb[2] - bb[0]) / 2 - bb[0], ty - (bb[3] - bb[1]) / 2 - bb[1]), "A", font=font, fill=(14, 14, 16, 255))

# --- red marker loop around the figure ---------------------------------------------------
red = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(red)
for loop, (rx, ry, start, sweep, w) in enumerate(((300, 400, -0.6, 5.6, 22), (318, 384, 0.4, 3.9, 16))):
    pts = []
    n = 90
    ph = random.uniform(0, 6)
    for i in range(n):
        a = start + sweep * i / n
        wob = 1 + 0.05 * math.sin(a * 3 + ph) + 0.03 * math.sin(a * 7 + ph * 2)
        pts.append(P(612 + math.cos(a) * rx * wob, 600 + math.sin(a) * ry * wob))
    rd.line(pts, fill=(232, 32, 42, 240), width=int(w * K), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = w * K / 2
        rd.ellipse([x - r, y - r, x + r, y + r], fill=(232, 32, 42, 240))
img = Image.alpha_composite(img, red)

# --- masking tape across the top-right corner ------------------------------------------------
tape = Image.new("RGBA", (S, S), (0, 0, 0, 0))
cx, cy, L, W, deg = *P(812, 196), 420 * K, 104 * K, 38
a = math.radians(deg)
c, s = math.cos(a), math.sin(a)
local = []
teeth = 7
for k in range(teeth + 1):
    local.append((-L / 2 + (random.uniform(6, 14) * K if k % 2 else 0), -W / 2 + W * k / teeth))
for k in range(teeth + 1):
    local.append((L / 2 - (random.uniform(6, 14) * K if k % 2 else 0), W / 2 - W * k / teeth))
tp = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in local]
tmask = mask_poly(tp)
img = Image.alpha_composite(img, shadow_of(tmask, 8 * K, 2 * K, 5 * K, 0.25))
tape_layer = Image.new("RGBA", (S, S), (190, 163, 122, 0))
streak = Image.effect_noise((S, S), 30).filter(ImageFilter.GaussianBlur(2)).rotate(-deg + 90, resample=Image.BICUBIC).resize((S, S))
tape_rgb = Image.merge("RGB", [ImageChops.add(Image.new("L", (S, S), base), streak, offset=-128) for base in (184, 158, 118)])
tape_layer = tape_rgb.convert("RGBA")
tape_layer.putalpha(tmask.point(lambda v: int(v * 0.86)))
img = Image.alpha_composite(img, tape_layer)

# --- rounded tile + thin rim ------------------------------------------------------------------
R = int(210 * K)
rmask = Image.new("L", (S, S), 0)
ImageDraw.Draw(rmask).rounded_rectangle([0, 0, S - 1, S - 1], R, fill=255)
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
tile.paste(img, (0, 0), rmask)
rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle([3 * K, 3 * K, S - 1 - 3 * K, S - 1 - 3 * K], R - 3 * K, outline=(20, 20, 22, 110), width=int(5 * K))
tile = Image.alpha_composite(tile, rim)

final = tile.resize((1024, 1024), Image.LANCZOS)
final.save(OUT / "icon.png")
final.save(OUT / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print("wrote", OUT / "icon.ico")
