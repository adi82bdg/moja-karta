#!/usr/bin/env python3
"""
Buduje paczki Mojej Karty dla Chrome, Edge, Opery i Firefoksa.

Użycie (w głównym folderze repozytorium):
    python narzedzia/zbuduj-wersje.py

Wynik: folder wersje/ z plikami moja-karta-<przeglądarka>-<wersja>.zip
Do paczek trafiają tylko pliki dodatku – README, zrzuty i narzędzia są pomijane.
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'wersje'
GECKO_ID = 'moja-karta@adi82bdg'

# pliki dodatku: wszystko z tych rozszerzeń w głównym folderze + folder icons/
EXT_TYPES = {'.js', '.html', '.css'}
EXT_DIRS = ['icons']


def chrome(m):
    return m


def edge(m):
    return m


def opera(m):
    # Opera nie pozwala zastąpić nowej karty i nie ma API wyszukiwarki
    m.pop('chrome_url_overrides', None)
    m['permissions'] = [p for p in m['permissions'] if p != 'search']
    return m


def firefox(m):
    # Firefox: tło jako skrypt (nie service worker), brak uprawnienia "favicon", wymagany identyfikator dodatku
    m['background'] = {'scripts': ['background.js'], 'type': 'module'}
    m['permissions'] = [p for p in m['permissions'] if p != 'favicon']
    m['browser_specific_settings'] = {
        'gecko': {
            'id': GECKO_ID,
            'strict_min_version': '140.0',
            'data_collection_permissions': {'required': ['none']}
        }
    }
    return m


VARIANTS = {'chrome': chrome, 'edge': edge, 'opera': opera, 'firefox': firefox}


def extension_files():
    files = [p for p in ROOT.iterdir() if p.is_file() and p.suffix in EXT_TYPES]
    for d in EXT_DIRS:
        files += [p for p in (ROOT / d).rglob('*') if p.is_file()]
    return sorted(files)


def build():
    OUT.mkdir(exist_ok=True)
    base = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    files = extension_files()
    for name, fix in VARIANTS.items():
        m = fix(json.loads(json.dumps(base)))
        dest = OUT / f'moja-karta-{name}-{base["version"]}.zip'
        with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('manifest.json', json.dumps(m, ensure_ascii=False, indent=2) + '\n')
            for p in files:
                z.write(p, p.relative_to(ROOT).as_posix())
        print(f'{dest.relative_to(ROOT)}  ({dest.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    build()
