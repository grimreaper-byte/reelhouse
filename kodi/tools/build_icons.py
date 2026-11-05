"""Renders the Reelhouse screens' textures for Kodi into the add-on's skin media folder:

  reelhouse/icons/<name>.png  the web app's icons (web/js/dom.js ICONS), white on transparent, tinted in the layouts;
                              for one with a spot of colour (dom.js SPOTS), the spot alone is <name>-spot.png
  reelhouse/logo.png          the film-reel logo (web/favicon.svg) in the accent colour, without its dark tile
  reelhouse/ui/*.png          plain shapes: white, rounded boxes and outlines (9-slice), circles, masks, gradients

    python kodi/tools/build_icons.py

Needs Pillow (a development machine only; the generated files are committed). Shapes are drawn 4x larger and
scaled down, so edges are smooth.
"""
import math
import os
import re

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'kodi', 'plugin.video.reelhouse', 'resources', 'skins', 'Default', 'media', 'reelhouse')
DOM_JS = os.path.join(ROOT, 'web', 'js', 'dom.js')
FAVICON = os.path.join(ROOT, 'web', 'favicon.svg')

SS = 4  # supersampling
ICON_SIZE = 96
ACCENT = (0xE5, 0xA0, 0x0D, 255)
# The icons the screens use, as the web app names them.
ICONS = ['home', 'film', 'tv', 'radio', 'search', 'settings', 'user', 'play', 'check', 'more', 'record', 'info',
         'star', 'chevronLeft', 'chevronRight', 'chevronDown', 'x', 'refresh', 'skipNext', 'skipPrev', 'list', 'grid',
         # the icons a library can be given (ui/model.py LIBRARY_ICONS), film and tv above
         'tvRecord', 'tvOld', 'tvFlat', 'tvPlay', 'clapperboard', 'movieCamera', 'trophy', 'heart',
         'signOut', 'fullscreen']  # the sidebar's Exit and Now playing
FILLED = {'play', 'pause', 'stop', 'star', 'record'}


# ---------- SVG paths ----------

def tokens(d):
    for m in re.finditer(r'[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?', d):
        yield m.group(0)


def arc_points(x1, y1, rx, ry, phi, fa, fs, x2, y2, n=24):
    """An SVG elliptical arc (endpoint form) as points, without its start (rotation phi unused by these icons)."""
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    x1p, y1p = (x1 - x2) / 2, (y1 - y2) / 2
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1:
        rx *= math.sqrt(lam)
        ry *= math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0, num / den)) * (-1 if fa == fs else 1) if den else 0
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = cxp + (x1 + x2) / 2, cyp + (y1 + y2) / 2
    a1 = math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    a2 = math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    da = a2 - a1
    if fs and da < 0:
        da += 2 * math.pi
    if not fs and da > 0:
        da -= 2 * math.pi
    return [(cx + rx * math.cos(a1 + da * i / n), cy + ry * math.sin(a1 + da * i / n)) for i in range(1, n + 1)]


def bezier(p0, p1, p2, p3, n=16):
    out = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def subpaths(d):
    """The path's pieces as lists of points, each with whether it was closed (Z)."""
    toks = list(tokens(d))
    i, cmd = 0, None
    x = y = sx = sy = 0.0
    last_ctrl = None
    current, out = [], []

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        if re.match(r'[A-Za-z]', toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in 'Zz':
                if current:
                    out.append((current, True))
                current, x, y = [], sx, sy
                continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == 'M':
            if current:
                out.append((current, False))
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            sx, sy = x, y
            current = [(x, y)]
            cmd = 'l' if rel else 'L'  # further pairs are lines
        elif c == 'L':
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            current.append((x, y))
        elif c == 'H':
            nx = num()
            x = x + nx if rel else nx
            current.append((x, y))
        elif c == 'V':
            ny = num()
            y = y + ny if rel else ny
            current.append((x, y))
        elif c in 'CS':
            if c == 'C':
                x1, y1 = num(), num()
                if rel:
                    x1, y1 = x + x1, y + y1
            else:
                x1, y1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
            x2, y2, nx, ny = num(), num(), num(), num()
            if rel:
                x2, y2, nx, ny = x + x2, y + y2, x + nx, y + ny
            current += bezier((x, y), (x1, y1), (x2, y2), (nx, ny))
            last_ctrl = (x2, y2)
            x, y = nx, ny
            continue
        elif c == 'A':
            rx, ry, phi, fa, fs, nx, ny = num(), num(), num(), num(), num(), num(), num()
            if rel:
                nx, ny = x + nx, y + ny
            current += arc_points(x, y, rx, ry, phi, int(fa), int(fs), nx, ny)
            x, y = nx, ny
        else:
            raise ValueError('path command {} not handled'.format(cmd))
        last_ctrl = None
    if current:
        out.append((current, False))
    return out


def render_icon(d, filled, stroke=2, size=ICON_SIZE):
    scale = size * SS / 24.0
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    width = stroke * scale
    for points, closed in subpaths(d):
        pts = [(px * scale, py * scale) for px, py in points]
        if filled:
            if len(pts) > 2:
                draw.polygon(pts, fill=(255, 255, 255, 255))
            continue
        if closed and pts[0] != pts[-1]:
            pts.append(pts[0])
        if len(pts) == 1 or (len(pts) == 2 and math.dist(pts[0], pts[1]) < 0.5 * scale):
            pts = [pts[0], pts[0]]  # a dot ("M5 12h.01")
        draw.line(pts, fill=(255, 255, 255, 255), width=int(round(width)), joint='curve')
        r = width / 2
        for px, py in pts:  # round caps and joins
            draw.ellipse((px - r, py - r, px + r, py + r), fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def web_icons():
    text = open(DOM_JS, encoding='utf-8').read()
    found = {}
    for name in ICONS:
        m = re.search(r"\n  {}: '([^']*)'".format(re.escape(name)), text)
        if not m:
            raise SystemExit('icon {} not in web/js/dom.js'.format(name))
        found[name] = m.group(1)
    return found


def web_spots():
    """The icons' spots of colour (dom.js SPOTS: name -> [x, y, radius] on the 24-unit grid)."""
    m = re.search(r'const SPOTS = \{(.*?)\};', open(DOM_JS, encoding='utf-8').read())
    return {name: tuple(float(v) for v in nums.split(','))
            for name, nums in re.findall(r'(\w+): \[([^\]]*)\]', m.group(1) if m else '')}


def render_spot(x, y, r, size=ICON_SIZE):
    """A spot alone, white (the layouts colour it), at its place on the icon."""
    scale = size * SS / 24.0
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse(((x - r) * scale, (y - r) * scale, (x + r) * scale, (y + r) * scale), fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


# ---------- the logo ----------

def render_logo(size=256):
    """web/favicon.svg without its tile: accent shapes, with the windows and sprocket holes cut out."""
    svg = open(FAVICON, encoding='utf-8').read()
    # Logo units: the reel's box is x 7..58, y 13..51 of the 64-unit tile; keep that box, square.
    box_x, box_y, box_w = 5, 0, 54
    scale = size * SS / box_w
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    fill = None
    for m in re.finditer(r'<(/?)(g|rect|circle)\b([^>]*?)/?>', svg):
        closing, name, rest = m.groups()
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', rest))
        if name == 'g':
            fill = None if closing else attrs.get('fill')
            continue
        if attrs.get('width') == '64':
            continue  # the dark tile
        colour = ACCENT if (fill or '').lower() == '#e5a00d' else (0, 0, 0, 0)
        tx = lambda v: (float(v) - box_x) * scale
        ty = lambda v: (float(v) - box_y) * scale
        if name == 'rect':
            x0, y0 = tx(attrs['x']), ty(attrs['y'])
            x1, y1 = x0 + float(attrs['width']) * scale, y0 + float(attrs['height']) * scale
            radius = float(attrs.get('rx', 0)) * scale
            draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=colour)
        else:
            cx, cy, r = tx(attrs['cx']), ty(attrs['cy']), float(attrs['r']) * scale
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=colour)
    return img.resize((size, size), Image.LANCZOS)


# ---------- plain shapes ----------

def rounded(size, radius, outline=0, colour=(255, 255, 255, 255)):
    w, h = size
    img = Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    box = (0, 0, w * SS - 1, h * SS - 1)
    if outline:
        draw.rounded_rectangle(box, radius=radius * SS, outline=colour, width=outline * SS)
    else:
        draw.rounded_rectangle(box, radius=radius * SS, fill=colour)
    return img.resize((w, h), Image.LANCZOS)


def gradient(w, h, stops, horizontal=False):
    """White with alpha going through [(0..1, alpha 0..1)]; Kodi tints it."""
    img = Image.new('RGBA', (w, h))
    n = w if horizontal else h
    px = img.load()
    for i in range(n):
        t = i / (n - 1)
        for (t0, a0), (t1, a1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                a = a0 + (a1 - a0) * ((t - t0) / (t1 - t0) if t1 > t0 else 0)
                break
        alpha = int(round(255 * a))
        if horizontal:
            for j in range(h):
                px[i, j] = (255, 255, 255, alpha)
        else:
            for j in range(w):
                px[j, i] = (255, 255, 255, alpha)
    return img


def shapes():
    return {
        'white.png': Image.new('RGBA', (16, 16), (255, 255, 255, 255)),
        # 9-slice pieces (the layouts give border="16"): boxes, pills and focus outlines of any size.
        'box.png': rounded((64, 64), 12),
        'box-small.png': rounded((64, 64), 7),
        'pill.png': rounded((64, 64), 31),
        # Small pills (badges 32 high, border="15"): with the big one's ends cut at 15 the middle of its curve stretched
        # into points.
        'pill-small.png': rounded((32, 32), 15),
        'frame.png': rounded((64, 64), 14, outline=4),
        'frame-pill.png': rounded((64, 64), 31, outline=4),
        # For controls the guide makes in Python, which can neither tint nor 9-slice a button's textures: ready-coloured
        # flat fills, which stretch to any size unharmed.
        'accent.png': Image.new('RGBA', (16, 16), ACCENT),
        'clear.png': Image.new('RGBA', (16, 16), (0, 0, 0, 0)),
        'circle.png': rounded((128, 128), 64),
        # Masks (diffuse): the picture's corners rounded at the size it's shown.
        'mask-poster.png': rounded((220, 330), 10),
        'mask-landscape.png': rounded((400, 225), 10),
        'mask-backdrop.png': rounded((480, 270), 10),
        # The backdrop's shading on item pages: dark from the left (where the text is) and towards the bottom.
        'shade-left.png': gradient(512, 8, [(0, 0.96), (0.45, 0.82), (0.75, 0.35), (1, 0.15)], horizontal=True),
        'shade-bottom.png': gradient(8, 512, [(0, 0), (0.45, 0.25), (1, 1)]),
        'shade-top.png': gradient(8, 256, [(0, 0.85), (1, 0)]),
    }


def main():
    for sub in ('icons', 'ui'):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    for name, d in web_icons().items():
        render_icon(d, name in FILLED, 3 if name == 'more' else 2).save(os.path.join(OUT, 'icons', name + '.png'), optimize=True)
    for name, (x, y, r) in web_spots().items():
        if name in ICONS:
            render_spot(x, y, r).save(os.path.join(OUT, 'icons', name + '-spot.png'), optimize=True)
    render_logo().save(os.path.join(OUT, 'logo.png'), optimize=True)
    for name, img in shapes().items():
        img.save(os.path.join(OUT, 'ui', name), optimize=True)
    print('textures written to', os.path.relpath(OUT, ROOT))


if __name__ == '__main__':
    main()
