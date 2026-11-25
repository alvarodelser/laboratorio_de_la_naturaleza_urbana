"""The archive database: db/archivo_fotografias.xlsx + db/{fotografias,audios,textos}/ -> web/data/cases.json + web/media/.

The spreadsheet is the source of truth; db/fotografias, db/audios and db/textos hold the files it describes. This
script validates them and writes what the map reads:
  web/data/cases.json      the cases that have a coordinate inside the map frame, with their photos, audios and texts
  web/media/fotos/         those photos as web JPEGs: at most MAX_PX on the longest side, metadata (GPS) removed
  web/media/audio/         those audios as AAC (.m4a, plays in every browser), metadata removed; needs ffmpeg

usage: python scripts/build_archive.py                  validate and build
       python scripts/build_archive.py --check          validate only
       python scripts/build_archive.py --extract-gps    first read GPS from new photos (see below)
Exits with status 1 on errors (nothing is written). Warnings (a case without a coordinate yet, a photo
without a row...) are listed but do not stop the build.

Spreadsheet: one row per photo. Rows with the same Identificador are one case; Versión (a, b, c...) tells
its photos apart. Rows without Identificador (e.g. research links in "Enlaces web") are ignored.
  Identificador   case number (Nº 001)
  Versión         a, b, c... (empty = a)
  Año             year or range (1960, 1957-64)
  Nombre imagen   description of the photo
  Archivo         source or author (archive, book, photographer)
  Localización    place; the first one of the case is its title on the map
  Coordenada      "lat, lon" in decimal degrees, as Google Maps copies it (40.43436, -3.63828).
                  One row of the case is enough. Optional column "Radio (m)": uncertainty radius
  Enlaces         link to the original (Drive)
  Enlaces web     the photo's page in an online archive (memoriademadrid.es...): the link when Enlaces is empty
Photos: db/fotografias/<Identificador>-<versión>.<ext>, or <Identificador>.<ext> for a single version;
anything after that is ignored (2-Parque-Marques-de-Suanzes.jpg is case 2, version a).
Audios and texts are named the same way, in db/audios (any common audio format) and db/textos (.txt, UTF-8): a row
is a photo, an audio or a text depending on which file has its number and version. Its Nombre imagen is the label.
The photos of a case are linked as versions of one view; its audios and texts are separate items.

Coordinates from photo metadata (--extract-gps): the GPS of each photo in db/fotografias is read, kept in
db/coordenadas_metadatos.csv, and then removed from the photo (losslessly) so nobody's location is published.
A point shared by photos of different cases is discarded: it is where old photos were re-photographed, not
the place. A case without Coordenada uses the first metadata point of its photos.

Approximate coordinates: db/coordenadas_aproximadas.csv (identificador, lat, lon, radio_m, lugar) holds estimates
made from Localización, with a radius for their uncertainty; the map draws them as approximate. They are the
last resort: Coordenada, then photo GPS, then the estimate.
"""
import argparse
import csv
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import unicodedata

from openpyxl import load_workbook
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import inside, proj

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
XLSX = os.path.join(ROOT, 'db', 'archivo_fotografias.xlsx')
PHOTOS = os.path.join(ROOT, 'db', 'fotografias')
GPS_CSV = os.path.join(ROOT, 'db', 'coordenadas_metadatos.csv')
APPROX_CSV = os.path.join(ROOT, 'db', 'coordenadas_aproximadas.csv')
SAME_SPOT_M = 30                     # GPS points closer than this in different cases: a re-photographing spot
OUT_JSON = os.path.join(ROOT, 'web', 'data', 'cases.json')
OUT_MEDIA = os.path.join(ROOT, 'web', 'media')
MAX_PX = 2000
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'}
AUDIOS = os.path.join(ROOT, 'db', 'audios')
TEXTS = os.path.join(ROOT, 'db', 'textos')
AUDIO_EXT = {'.opus', '.ogg', '.oga', '.webm', '.m4a', '.mp4', '.mp3', '.wav', '.aac', '.amr', '.3gp', '.caf', '.flac'}
TEXT_EXT = {'.txt', '.md'}
PHOTO_NAME = re.compile(r'^(\d+)(?:-([a-z]))?(?![a-z])', re.I)
COORD = re.compile(r'^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$')
NOTE = ('Archive cases, built from db/archivo_fotografias.xlsx by scripts/build_archive.py: do not edit by hand. '
        'Each case is geolocated: exact (lon/lat) or approximate (lon/lat + r in metres). '
        'loc says where the coordinate comes from: sheet (Coordenada), gps (photo metadata) or estimate (from Localización). '
        'Items: versions {photos:[{src,label,year,credit,v}...]} (one photo in several versions), photo {src,label,year,credit}, '
        'text {body,label}, audio {src,label}, file {src,label}.')
COLUMNS = {'id': 'identificador', 'version': 'version', 'year': 'ano', 'name': 'nombre imagen', 'source': 'archivo',
           'place': 'localizacion', 'coord': 'coordenada', 'link': 'enlaces', 'web': 'enlaces web',
           'radius': 'radio (m)'}
REQUIRED = ('id', 'name')


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, where, msg):
        self.errors.append(f'{where}: {msg}')

    def warn(self, where, msg):
        self.warnings.append(f'{where}: {msg}')


def fold(s):
    """Lowercase, accents removed: header matching that survives "Versión" vs "Version"."""
    return ''.join(c for c in unicodedata.normalize('NFD', str(s or '').strip().lower()) if unicodedata.category(c) != 'Mn')


def text(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return ' '.join(str(v).split())                                   # collapse whitespace and newlines


def tidy(name):
    """A name typed as a file name (Parque-Marques-de-Suanzes) reads as words."""
    return name.replace('-', ' ') if ' ' not in name and '-' in name else name


def read_rows(rep):
    ws = load_workbook(XLSX, read_only=True, data_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [fold(h) for h in next(rows, ())]
    col = {k: header.index(name) for k, name in COLUMNS.items() if name in header}
    for k in REQUIRED:
        if k not in col:
            rep.error(os.path.basename(XLSX), f'missing column "{COLUMNS[k]}"')
    if rep.errors:
        return []
    out = []
    for i, row in enumerate(rows, start=2):
        rec = {k: row[j] if j < len(row) else None for k, j in col.items()}
        if text(rec['id']) == '':
            continue                                                   # link-only or blank row
        rec['_where'] = f'row {i}'
        if not any(text(v) for k, v in rec.items() if k not in ('id', '_where')):
            rep.warn(rec['_where'], f'Identificador {text(rec["id"])} has nothing else yet: skipped')   # a number reserved for later
            continue
        out.append(rec)
    return out


def index_files(rep, folder, exts, example):
    """{(case number, version): filename} for the files directly in a db/ folder."""
    found, where = {}, os.path.relpath(folder, ROOT)
    for f in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        p = os.path.join(folder, f)
        if f.startswith('.') or not os.path.isfile(p):
            continue
        m = PHOTO_NAME.match(f)
        if not m or os.path.splitext(f)[1].lower() not in exts:
            rep.warn(where, f'"{f}" is not named <Identificador>-<versión>.{example}: ignored')
            continue
        key = (int(m.group(1)), (m.group(2) or 'a').lower())
        if key in found:
            rep.error(where, f'"{f}" and "{found[key]}" are both {key[0]}-{key[1]}')
        found[key] = f
    return found


def index_photos(rep):
    return index_files(rep, PHOTOS, IMAGE_EXT, 'jpg')


def parse_coord(rec, rep):
    s = text(rec.get('coord'))
    if not s:
        return None
    m = COORD.match(s.replace(', ', ','))
    if not m:
        rep.error(rec['_where'], f'Coordenada "{s}" should be "lat, lon" in decimal degrees (40.43436, -3.63828)')
        return None
    a, b = float(m.group(1)), float(m.group(2))
    lat, lon = (a, b) if abs(a) > abs(b) else (b, a)                  # in Madrid |lat| ~ 40 > |lon| ~ 3.7
    return lat, lon


def read_gps(path):
    """(lat, lon) from a photo's EXIF, or None."""
    try:
        with Image.open(path) as im:
            g = im.getexif().get_ifd(0x8825)
        dms = lambda v: float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
        lat, lon = dms(g[2]), dms(g[4])
        if not (math.isfinite(lat) and math.isfinite(lon)) or (lat == 0 and lon == 0):
            return None                                                 # an empty GPS tag (NaN or 0, 0)
        return (-lat if g.get(1) == 'S' else lat, -lon if g.get(3) == 'W' else lon)
    except Exception:
        return None


def strip_exif(path):
    """Drop the EXIF segment of a JPEG without re-encoding it (image data untouched)."""
    with open(path, 'rb') as f:
        b = f.read()
    if b[:2] != b'\xff\xd8':
        return False
    out, i = bytearray(b[:2]), 2
    while i + 4 <= len(b) and b[i] == 0xff:
        m = b[i + 1]
        if m == 0xda:                                                   # start of scan: the rest is image data
            break
        n = struct.unpack('>H', b[i + 2:i + 4])[0]
        if not (m == 0xe1 and b[i + 4:i + 10] == b'Exif\0\0'):
            out += b[i:i + 2 + n]
        i += 2 + n
    out += b[i:]
    with open(path, 'wb') as f:
        f.write(out)
    return True


def metres(a, b):
    return math.hypot((a[0] - b[0]) * 110574, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))


def load_gps_csv():
    """{(case, version): (lat, lon)} from db/coordenadas_metadatos.csv."""
    if not os.path.exists(GPS_CSV):
        return {}
    with open(GPS_CSV, newline='') as f:
        return {(int(r['identificador']), r['version']): (float(r['lat']), float(r['lon'])) for r in csv.DictReader(f)}


def load_approx_csv():
    """{case: (lat, lon, radius m)} from db/coordenadas_aproximadas.csv."""
    if not os.path.exists(APPROX_CSV):
        return {}
    with open(APPROX_CSV, newline='') as f:
        return {int(r['identificador']): (float(r['lat']), float(r['lon']), int(r['radio_m'])) for r in csv.DictReader(f)}


def extract_gps(photos):
    """Read GPS from the photos into the CSV (dropping re-photographing spots), then strip it from them."""
    known, found = load_gps_csv(), {}
    for key, f in photos.items():
        g = read_gps(os.path.join(PHOTOS, f))
        if g:
            found[key] = g
    points = {**known, **found}
    kept, dropped = dict(known), []
    for key, g in found.items():
        if any(k[0] != key[0] and metres(g, p) < SAME_SPOT_M for k, p in points.items()):
            dropped.append(f'{key[0]}-{key[1]}')
        else:
            kept[key] = g
    with open(GPS_CSV, 'w', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['identificador', 'version', 'lat', 'lon'])
        for (n, v), (lat, lon) in sorted(kept.items()):
            w.writerow([n, v, f'{lat:.5f}', f'{lon:.5f}'])
    for root, _, fs in os.walk(PHOTOS):
        for f in fs:
            p = os.path.join(root, f)
            if read_gps(p) and os.path.splitext(f)[1].lower() in ('.jpg', '.jpeg'):
                strip_exif(p)
    print(f'GPS: {len(found)} photos had it, {len(found) - len(dropped)} kept in {os.path.relpath(GPS_CSV, ROOT)}'
          + (f'; discarded as a shared re-photographing spot: {", ".join(sorted(dropped))}' if dropped else ''))


def build_cases(rows, photos, rep, gps=None, approx=None, audios=None, texts=None):
    audios, texts = audios or {}, texts or {}
    groups = {}
    for r in rows:
        try:
            n = int(float(text(r['id'])))
            if n < 1:
                raise ValueError
        except ValueError:
            rep.error(r['_where'], f'Identificador "{text(r["id"])}" must be a whole number')
            continue
        v = text(r.get('version')).lower() or 'a'
        if not re.fullmatch(r'[a-z]', v):
            rep.error(r['_where'], f'Versión "{v}" must be one letter (a, b, c...)')
            continue
        if any(x['_v'] == v for x in groups.get(n, [])):
            rep.error(r['_where'], f'photo {n}-{v} appears twice')
            continue
        r['_v'] = v
        groups.setdefault(n, []).append(r)

    cases, used = [], set()
    for n, rs in sorted(groups.items()):
        where = f'case {n}'
        coords, loc, approx_r = [c for c in (parse_coord(r, rep) for r in rs) if c], 'sheet', None
        if not coords:                                                  # fall back to photo metadata
            coords, loc = [g for (m, v), g in sorted((gps or {}).items()) if m == n][:1], 'gps'
        if not coords and n in (approx or {}):                          # last resort: an estimate with a radius
            lat, lon, approx_r = approx[n]
            coords, loc = [(lat, lon)], 'estimate'
        if len({(round(a, 4), round(b, 4)) for a, b in coords}) > 1:
            rep.warn(where, f'rows give different coordinates; using the first, {coords[0]}')
        items = []
        for r in sorted(rs, key=lambda r: r['_v']):
            name, year, source = text(r['name']), text(r.get('year')), text(r.get('source'))
            if not name:
                rep.error(r['_where'], 'missing Nombre imagen')
            key = (n, r['_v'])
            have = [(t, d[key]) for t, d in (('photo', photos), ('audio', audios), ('text', texts)) if key in d]
            if not have:
                rep.warn(r['_where'], f'no file {n}-{r["_v"]} in db/fotografias, db/audios or db/textos')
                continue
            if len(have) > 1:
                rep.error(r['_where'], f'{n}-{r["_v"]} is in more than one folder: ' + ', '.join(f for _, f in have))
                continue
            used.add(key)
            kind, f = have[0]
            item = {'type': kind, '_v': r['_v'], 'label': tidy(name)}
            if kind == 'text':
                with open(os.path.join(TEXTS, f), encoding='utf-8') as fh:
                    item['body'] = re.sub(r'\n{3,}', '\n\n', fh.read().replace('\r\n', '\n')).strip()
                if not item['body']:
                    rep.error(r['_where'], f'db/textos/{f} is empty')
            else:
                item['src'] = f
            if year:
                item['year'] = year                                     # shown on the photo itself
            if source:
                item['credit'] = source
            link = text(r.get('link')) or text(r.get('web'))         # the original: Drive, or the archive's own page
            if link.startswith('http'):
                item['link'] = link
            items.append(item)
        title = next((text(r.get('place')) for r in rs if text(r.get('place'))), '') or text(rs[0]['name'])
        title = tidy(title[:1].upper() + title[1:])
        pics = [it for it in items if it['type'] == 'photo']
        if len(pics) > 1:                                               # the versions of one photo, linked, where the first was
            linked = {'type': 'versions', 'photos': [{k: x for k, x in it.items() if k != 'type'} | {'v': it['_v']} for it in pics]}
            first = items.index(pics[0])
            items = [it for it in items if it['type'] != 'photo']
            items.insert(first, linked)
        years = list(dict.fromkeys(text(r.get('year')) for r in rs if text(r.get('year'))))
        case = {'id': f'c{n}', 'n': n, 'title': title, 'items': items, '_where': where}
        if years:
            case['date'] = ' / '.join(years)
        if not items:
            rep.warn(where, 'has no files yet: not on the map')
            continue
        if not coords:
            rep.warn(where, f'"{title}" has no Coordenada yet: not on the map')
            continue
        lat, lon = coords[0]
        if not inside(*proj(lon, lat)):
            rep.warn(where, f'{lat}, {lon} is outside the map frame (scripts/frame.py): not on the map')
            continue
        case['lat'], case['lon'], case['loc'] = lat, lon, loc
        radius = text(next((r.get('radius') for r in rs if text(r.get('radius'))), ''))
        if radius:
            try:
                case['r'] = int(round(float(radius)))
            except ValueError:
                rep.error(where, f'Radio (m) "{radius}" must be a number of metres')
        elif approx_r:
            case['r'] = approx_r
        cases.append(case)
    for folder, d in (('db/fotografias', photos), ('db/audios', audios), ('db/textos', texts)):
        for key in sorted(set(d) - used):
            rep.warn(folder, f'"{d[key]}" has no row in the spreadsheet')
    return cases


def export_photo(src_name, dst_rel):
    """A web copy: upright, scaled to MAX_PX, re-encoded as JPEG without metadata (no GPS goes online)."""
    with Image.open(os.path.join(PHOTOS, src_name)) as im:
        im = ImageOps.exif_transpose(im).convert('RGB')
        im.thumbnail((MAX_PX, MAX_PX), Image.LANCZOS)
        dst = os.path.join(OUT_MEDIA, dst_rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.save(dst, 'JPEG', quality=85, optimize=True, progressive=True)


def export_audio(src_name, dst_rel):
    """A web copy: AAC in .m4a (Safari cannot play Opus or WebM everywhere), mono, metadata removed."""
    dst = os.path.join(OUT_MEDIA, dst_rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(AUDIOS, src_name), '-vn', '-map_metadata', '-1',
                        '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'ffmpeg could not convert db/audios/{src_name}: {r.stderr.strip()}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='validate only, write nothing')
    ap.add_argument('--extract-gps', action='store_true', help='read GPS from the photos first (and strip it)')
    a = ap.parse_args()

    rep = Report()
    rows = read_rows(rep)
    photos = index_photos(rep)
    audios = index_files(rep, AUDIOS, AUDIO_EXT, 'm4a')
    texts = index_files(rep, TEXTS, TEXT_EXT, 'txt')
    if a.extract_gps and not a.check:
        extract_gps(photos)
    cases = build_cases(rows, photos, rep, load_gps_csv(), load_approx_csv(), audios, texts) if not rep.errors else []
    if any(it['type'] == 'audio' for c in cases for it in c['items']) and not shutil.which('ffmpeg'):
        rep.error('db/audios', 'converting audios needs ffmpeg (brew install ffmpeg)')
    for w in rep.warnings:
        print('warning:', w)
    for e in rep.errors:
        print('ERROR:  ', e)
    sys.stdout.flush()
    if rep.errors:
        sys.exit(f'{len(rep.errors)} error(s): nothing written. Fix the spreadsheet and run again.')
    print(f'ok: {len({text(r["id"]) for r in rows})} cases in the spreadsheet, {len(cases)} on the map')
    if a.check:
        return

    shutil.rmtree(OUT_MEDIA, ignore_errors=True)
    for c in cases:
        del c['_where']
        for it in c['items']:
            for ph in it['photos'] if it['type'] == 'versions' else [it] if it['type'] == 'photo' else []:
                rel = f'fotos/{c["n"]}-{ph.pop("_v")}.jpg'
                export_photo(ph['src'], rel)
                ph['src'] = 'media/' + rel
            if it['type'] == 'audio':
                rel = f'audio/{c["n"]}-{it.pop("_v")}.m4a'
                export_audio(it['src'], rel)
                it['src'] = 'media/' + rel
            elif it['type'] == 'text':
                it.pop('_v')
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump({'note': NOTE, 'cases': cases}, f, ensure_ascii=False, indent=1)
    print(f'wrote {os.path.relpath(OUT_JSON, ROOT)} and {os.path.relpath(OUT_MEDIA, ROOT)}/')


if __name__ == '__main__':
    main()
