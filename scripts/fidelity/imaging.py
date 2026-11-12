"""Shared image helpers for the fidelity tools. Every coordinate is in CSS px.

HideGPT captures are 2x. The Google Docs references come in two kinds:
2940x1912 is a 1470 CSS px viewport at 2x with 66 device px of browser bar on
top; 1280-wide is a 1402 CSS px viewport scaled down to 1280.
"""

import numpy as np
from PIL import Image

REF_BAR = 66


def load(path):
    """An RGB image as an int array, plus its CSS-to-device scale and top offset."""
    img = Image.open(path).convert('RGB')
    if img.width == 1280:
        scale, top = 1280 / 1402, 0
    elif img.size == (2940, 1912):
        scale, top = 2.0, REF_BAR
    else:
        scale, top = 2.0, 0
    return np.asarray(img).astype(int), scale, top


def crop(image, x, y, w, h):
    a, scale, top = image
    return a[round(y * scale) + top:round((y + h) * scale) + top, round(x * scale):round((x + w) * scale)]


def ink(image, x, y, w, h, threshold=0.25):
    """Ink in a region: its bounding box, centre, darkest colour, and mass.

    Mass is darkness-weighted area in CSS px^2, normalised to the region's own
    darkest pixel, so it compares stroke weight across text colours.
    """
    scale = image[1]
    a = crop(image, x, y, w, h)
    lum = a.mean(axis=2)
    bg = np.median(lum)
    d = np.clip((bg - lum) / max(bg - lum.min(), 1), 0, 1)
    ys, xs = np.where(d > threshold)
    if len(xs) == 0:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    darkest = a.reshape(-1, 3)[lum.argmin()]
    return {
        'x': x + x0 / scale, 'y': y + y0 / scale, 'w': (x1 - x0) / scale, 'h': (y1 - y0) / scale,
        'cx': x + (x0 + x1) / 2 / scale, 'cy': y + (y0 + y1) / 2 / scale,
        'mass': d.sum() / scale ** 2, 'darkest': hex_colour(darkest),
    }


def pixel(image, x, y):
    """The colour of the device pixel under a CSS point."""
    a, scale, top = image
    return hex_colour(a[int(y * scale) + top, int(x * scale)])


def hex_colour(colour):
    """(r, g, b) or (r, g, b, a) -> '#rrggbb', with 'aa' appended when not opaque."""
    channels = [int(v) for v in colour[:4]]
    if len(channels) == 4 and channels[3] == 255:
        channels = channels[:3]
    return '#' + ''.join('%02x' % v for v in channels)


def parse_colour(value):
    """'#rrggbb[aa]', 'rgb(r, g, b)' or 'rgba(r, g, b, a)' -> (r, g, b, a), a in 0-255.

    Alpha counts as a fourth channel, so a transparent colour never matches an
    opaque target.
    """
    value = value.strip()
    if value.startswith('#'):
        channels = [int(value[i:i + 2], 16) for i in range(1, len(value), 2)]
        return tuple(channels + [255] * (4 - len(channels)))
    parts = [v.strip() for v in value[value.index('(') + 1:value.index(')')].replace('/', ',').split(',')]
    alpha = parts[3] if len(parts) > 3 else '1'
    alpha = float(alpha[:-1]) / 100 if alpha.endswith('%') else float(alpha)
    return tuple(round(float(v)) for v in parts[:3]) + (round(alpha * 255),)
