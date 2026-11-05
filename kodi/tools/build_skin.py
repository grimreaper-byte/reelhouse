"""Writes the Reelhouse screens' Kodi layouts from kodi/skin-src into the add-on (resources/skins/Default/1080i).

    python kodi/tools/build_skin.py          write them
    python kodi/tools/build_skin.py --check  only say whether they're up to date (the tests use this)

An add-on's windows can't use a skin's includes, so the shared pieces (sidebar, top bar, rows of posters…) are kept
once in skin-src/includes and stitched in here:

  <!-- include NAME key=value key="value with spaces" -->   the include, its {{key}} placeholders filled in
  <!-- repeat n=0..11 --> … <!-- /repeat -->                copies, with {{n}}, {{300+n}} and {{152+90*n}} worked out
  {{BG}}, {{ACCENT}}…                                       the web app's colours (PALETTE)
"""
import os
import re
import sys
from xml.etree import ElementTree

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, '..', 'skin-src'))
OUT = os.path.normpath(os.path.join(HERE, '..', 'plugin.video.reelhouse', 'resources', 'skins', 'Default', '1080i'))

# web/css/app.css, as Kodi colours (AARRGGBB).
PALETTE = {
    'BG': 'FF111315', 'ELEV': 'FF191C20', 'ELEV2': 'FF22262B', 'ELEV3': 'FF2C3137', 'SIDEBAR': 'FF0B0C0E',
    'BORDER': 'FF2A2F35', 'TEXT': 'FFECEFF3', 'TEXT_DIM': 'FFA2ABB5', 'TEXT_FAINT': 'FF6F7882', 'ACCENT': 'FFE5A00D',
    'ACCENT_TEXT': 'FF1A1300', 'DANGER': 'FFE5534B', 'OK': 'FF3FB950', 'WARN': 'FFD29922',
}
# The guide's genre colours (the web app's, from Kodi's Estuary), GENRE1…GENRE11.
GENRES = [(219, 120, 23), (100, 154, 100), (219, 217, 23), (237, 14, 40), (23, 219, 194), (65, 234, 77), (0, 67, 236),
          (198, 200, 203), (158, 32, 158), (147, 147, 207), (29, 161, 177)]
PALETTE.update(('GENRE{}'.format(n), 'FF{:02X}{:02X}{:02X}'.format(*rgb)) for n, rgb in enumerate(GENRES, 1))

INCLUDE = re.compile(r'<!--\s*include\s+([\w-]+)((?:\s+[\w-]+=(?:"[^"]*"|\S+?))*)\s*-->')
REPEAT = re.compile(r'<!--\s*repeat\s+n=(\d+)\.\.(\d+)\s*-->(.*?)<!--\s*/repeat\s*-->', re.S)
PARAM = re.compile(r'([\w-]+)=("[^"]*"|\S+)')
PLACEHOLDER = re.compile(r'\{\{([\w-]+)\}\}')
ARITH = re.compile(r'\{\{(\d+)\+(?:(\d+)\*)?n\}\}')


def includes():
    found = {}
    folder = os.path.join(SRC, 'includes')
    for name in os.listdir(folder):
        if name.endswith('.xml'):
            with open(os.path.join(folder, name), encoding='utf-8') as f:
                found[name[:-4]] = f.read()
    return found


def expand(text, incs, depth=0):
    if depth > 8:
        raise ValueError('includes nest too deep')

    def repeat(m):
        first, last, body = int(m.group(1)), int(m.group(2)), m.group(3)
        out = []
        for n in range(first, last + 1):
            piece = ARITH.sub(lambda a: str(int(a.group(1)) + int(a.group(2) or 1) * n), body)
            out.append(piece.replace('{{n}}', str(n)))
        return ''.join(out)

    text = REPEAT.sub(repeat, text)

    def include(m):
        name, raw = m.group(1), m.group(2) or ''
        if name not in incs:
            raise ValueError('no include named ' + name)
        params = dict((k, v[1:-1] if v.startswith('"') else v) for k, v in PARAM.findall(raw))
        body = PLACEHOLDER.sub(lambda p: params.get(p.group(1), p.group(0)), incs[name])
        return expand(body, incs, depth + 1)

    text = INCLUDE.sub(include, text)
    return text


def build():
    incs = includes()
    out = {}
    folder = os.path.join(SRC, 'windows')
    for name in sorted(os.listdir(folder)):
        if not name.endswith('.xml'):
            continue
        with open(os.path.join(folder, name), encoding='utf-8') as f:
            text = expand(f.read(), incs)
        text = PLACEHOLDER.sub(lambda p: PALETTE.get(p.group(1), p.group(0)), text)
        left = PLACEHOLDER.search(text)
        if left:
            raise ValueError('{}: {} not filled in'.format(name, left.group(0)))
        ElementTree.fromstring(text.encode('utf-8'))  # well-formed, or this raises
        header = '<!-- Made by kodi/tools/build_skin.py from kodi/skin-src/windows/{}: edit that, not this. -->\n'.format(name)
        out[name] = text.replace('?>\n', '?>\n' + header, 1)
    return out


def main():
    check = '--check' in sys.argv
    built = build()
    stale = []
    os.makedirs(OUT, exist_ok=True)
    for name, text in built.items():
        path = os.path.join(OUT, name)
        current = open(path, encoding='utf-8').read() if os.path.exists(path) else None
        if current != text:
            stale.append(name)
            if not check:
                with open(path, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(text)
    extra = [n for n in os.listdir(OUT) if n.endswith('.xml') and n not in built]
    if check:
        if stale or extra:
            print('out of date: ' + ', '.join(stale + extra))
            return 1
        print('layouts up to date')
        return 0
    for name in extra:
        os.remove(os.path.join(OUT, name))
    print('{} layouts written, {} changed'.format(len(built), len(stale)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
