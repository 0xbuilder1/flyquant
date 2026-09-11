#!/usr/bin/env python3
"""
The brand, drawn from the animal rather than about it.

    python brand/render.py

Every pixel here is a real cell body. The logo is 139,600 soma positions from MaleCNS v1.0 projected
to the frontal plane — no illustration, no stock art, nothing drawn by hand. The two lobes that read
as eyes ARE the optic lobes, which is why it survives being shrunk to a wallet icon: the silhouette
is a face because the animal's is.

Colour follows the site exactly: resting green phosphor, and amber where the neuron count is densest,
because that is where the arena actually drives it.

Outputs
    brand/logo.png          1024 square, transparent — wallets, PONS, avatars
    brand/logo-black.png    1024 square on black — anywhere transparency renders badly
    brand/banner.png        1500x500 — the X header
"""
import os
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH = os.path.join(HERE, '..', 'brain', 'graph')

GREEN = np.array([43, 255, 136], dtype=float)
AMBER = np.array([255, 176, 0], dtype=float)


def load_points():
    with open(os.path.join(GRAPH, 'cloud-xyz.bin'), 'rb') as f:
        raw = f.read()
    xyz = np.frombuffer(raw, dtype=np.int16).astype(np.float64).reshape(-1, 3) / 32767.0
    return xyz


def project(xyz, w, h, yaw=0.0, pitch=0.18, zoom=1.0):
    """frontal view — the one where the optic lobes sit either side like eyes"""
    cy, sy = np.cos(yaw), np.sin(yaw)
    x = xyz[:, 0] * cy + xyz[:, 2] * sy
    y = xyz[:, 1]
    z = -xyz[:, 0] * sy + xyz[:, 2] * cy
    cp, sp = np.cos(pitch), np.sin(pitch)
    y2 = y * cp - z * sp
    scale = min(w, h) * 0.46 * zoom
    px = (w / 2 + x * scale).astype(int)
    py = (h / 2 + y2 * scale * 1.35).astype(int)
    return px, py


def blur3(a):
    """a separable 1-2-1 pass, in numpy.

    PIL's GaussianBlur refuses a float-mode image, and rounding the accumulator to 8 bits before
    blurring throws away exactly the low counts that make the outer neuropil visible."""
    k = np.array([1.0, 2.0, 1.0]); k /= k.sum()
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * np.roll(a, i - 1, axis=0)
    a2 = np.zeros_like(out)
    for i, w in enumerate(k):
        a2 += w * np.roll(out, i - 1, axis=1)
    return a2


def splat(w, h, px, py, gain=1.0):
    """density, accumulated — a neuron is one count, and brightness is how many landed together"""
    ok = (px >= 0) & (px < w) & (py >= 0) & (py < h)
    acc = np.zeros((h, w), dtype=np.float32)
    np.add.at(acc, (py[ok], px[ok]), 1.0)
    acc = blur3(acc)
    m = np.percentile(acc[acc > 0], 99.2) if (acc > 0).any() else 1.0
    return np.clip(acc / max(m, 1e-6) * gain, 0, 1)


def colourise(d):
    """green where it is quiet, amber where it is dense — the site's own ramp"""
    t = np.clip((d - 0.35) / 0.65, 0, 1)[..., None]
    rgb = GREEN[None, None, :] * (1 - t) + AMBER[None, None, :] * t
    a = np.clip(d * 1.35, 0, 1)
    img = np.concatenate([rgb * np.clip(d * 1.5, 0, 1)[..., None], (a * 255)[..., None]], axis=2)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGBA')


def glow(img, radius, strength):
    b = img.filter(ImageFilter.GaussianBlur(radius))
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out = Image.alpha_composite(out, Image.blend(Image.new('RGBA', img.size, (0, 0, 0, 0)), b, strength))
    return Image.alpha_composite(out, img)


def scanlines(img, step=3, dark=0.82):
    a = np.array(img).astype(np.float32)
    a[::step, :, :3] *= dark
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def font(size):
    for name in ('consola.ttf', 'cour.ttf', 'DejaVuSansMono.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def fit(img, size, pad=0.045):
    """Crop to what is actually drawn, then centre it.

    The soma cloud is not centred in its own coordinate space — the brain sits low and the ventral
    nerve cord trails off — so projecting into a square leaves a third of the frame empty and the
    icon reads tiny at 64px. Cropping to the content is what makes it fill a wallet row."""
    a = np.array(img)
    ys, xs = np.where(a[..., 3] > 8)
    if not len(xs):
        return img
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = x1 - x0, y1 - y0
    side = int(max(w, h) * (1 + pad * 2))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.alpha_composite(img, (side // 2 - cx, side // 2 - cy))
    return out.resize((size, size), Image.LANCZOS)


def make_logo(xyz, size=1024, on_black=False):
    # rendered oversized, then cropped down — cropping first would throw away the resolution
    r = int(size * 1.6)
    px, py = project(xyz, r, r, zoom=1.02)
    d = splat(r, r, px, py, gain=1.25)
    img = glow(colourise(d), radius=r * 0.012, strength=0.6)
    img = fit(img, size)
    img = scanlines(img, step=max(2, size // 340))
    if on_black:
        bg = Image.new('RGBA', (size, size), (5, 7, 6, 255))
        img = Image.alpha_composite(bg, img)
    return img


def make_banner(xyz, w=1500, h=500):
    bg = Image.new('RGBA', (w, h), (5, 7, 6, 255))

    # the brain, cropped to itself then bled off the right edge
    bw = int(h * 1.55)
    brain = make_logo(xyz, bw)
    bg.alpha_composite(brain, (w - int(bw * 0.80), int(h / 2 - bw / 2)))

    dr = ImageDraw.Draw(bg)
    big = font(92)
    # MEASURED, not guessed: hardcoding the second word's x put the Y of FLY through the B of BRAIN
    dr.text((64, 150), 'FLY', font=big, fill=(255, 176, 0, 255))
    dr.text((64 + dr.textlength('FLY', font=big), 150), 'BRAIN', font=big, fill=(43, 255, 136, 255))
    dr.text((66, 258), 'a whole fruit fly connectome, trading', font=font(27), fill=(200, 245, 216, 235))
    dr.text((66, 296), '165,836 neurons  ·  6,242,118 connections', font=font(22), fill=(78, 130, 102, 255))
    dr.text((66, 330), 'every flash is a real spike', font=font(22), fill=(78, 130, 102, 255))
    dr.text((66, 392), 'flybrain@rh:~$ ', font=font(21), fill=(45, 84, 66, 255))
    dr.rectangle([236, 392, 248, 414], fill=(43, 255, 136, 255))

    out = scanlines(bg, step=3, dark=0.86)
    vig = Image.new('L', (w, h), 0)
    ImageDraw.Draw(vig).ellipse([-w * 0.15, -h * 0.7, w * 1.15, h * 1.7], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(90))
    a = np.array(out).astype(np.float32)
    a[..., :3] *= (0.42 + 0.58 * (np.array(vig).astype(np.float32) / 255.0))[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def main():
    xyz = load_points()
    print(f'{len(xyz):,} soma positions')

    logo = make_logo(xyz, 1024)
    logo.save(os.path.join(HERE, 'logo.png'))
    logo.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, 'logo-512.png'))
    logo.resize((128, 128), Image.LANCZOS).save(os.path.join(HERE, 'logo-128.png'))
    make_logo(xyz, 1024, on_black=True).save(os.path.join(HERE, 'logo-black.png'))
    make_banner(xyz).save(os.path.join(HERE, 'banner.png'))

    for f in ('logo.png', 'logo-512.png', 'logo-128.png', 'logo-black.png', 'banner.png'):
        p = os.path.join(HERE, f)
        print(f'  {f:<16} {Image.open(p).size}  {os.path.getsize(p) // 1024}kb')


if __name__ == '__main__':
    main()
