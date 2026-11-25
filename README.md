# Laboratorio de la Naturaleza Urbana

A map of Madrid's urban nature: Catastro buildings, the 2026 municipal tree inventory, parks and water, the 1956 and
current orthophotos, and an archive of geolocated cases (photos, before/after pairs, texts, audio, documents).

## Layout

```
db/                          the archive database: edit this
  archivo_fotografias.xlsx   one row per photo, audio or text; rows sharing an Identificador form a case
  fotografias/               the photos, named <Identificador>-<versión>.jpg (or <Identificador>.jpg)
  fotografias/sin_catalogar/ photos not in the spreadsheet yet
  audios/                    audio recordings, named like the photos (<Identificador>-<versión>.<ext>)
  textos/                    texts (.txt), named like the photos
  coordenadas_metadatos.csv  coordinates read from the photos' GPS (scripts/build_archive.py --extract-gps)
  coordenadas_aproximadas.csv  estimated coordinates (with an uncertainty radius) for cases without a better one
  fuentes.xlsx               research links: archives and collections to look through
web/                   the site (static, no build step): index.html, app.js, app.css
  data/                map data: buildings.json, trees.json, osm.json, places.json, cases.json (generated from db/)
  media/               web copies of the photos and audios (generated from db/)
  tiles/1956/          1956 orthophoto tile pyramid
scripts/               data pipeline (Python) and the proposal review tools
api/proponer.js        Vercel Function behind the map's "Contribuir al archivo" form
palettes/              palette lab: the same map crop drawn in candidate palettes
```

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Editing the archive

1. Add a row per photo to `db/archivo_fotografias.xlsx`: Identificador, Versión (a, b, c…), Año, Nombre imagen,
   Archivo (source), Localización, Coordenada, Enlaces. The first Localización of a case is its title on the map.
2. Save the photo in `db/fotografias/` as `<Identificador>-<versión>.jpg` (e.g. `6-c.jpg`); text after it is ignored.
   The versions of a case are linked: on the map they take turns on the card, and the viewer shows them side by
   side with a divider between each.
3. **Coordenada** puts the case on the map: `lat, lon` as Google Maps copies it (right-click a place → copy
   `40.43436, -3.63828`). Without one, a case uses the GPS of its photos if they had any (below);
   otherwise it is listed as a warning and left off the map.
4. Validate and build:

```sh
.venv/bin/python scripts/build_archive.py --check   # validate only
.venv/bin/python scripts/build_archive.py           # validate, then write web/data/cases.json and web/media/
```

Commit `web/data/cases.json` and `web/media/` with the spreadsheet: the site is served as is (no build on Vercel).

**Coordinates from photo metadata.** After adding phone photos, run `build_archive.py --extract-gps` once: it
reads each photo's GPS into `db/coordenadas_metadatos.csv` and then removes it from the photo (losslessly), so
nobody's location is published. A point shared by photos of *different* cases is discarded: that is where old
album photos were re-photographed, not the place. The Coordenada column always wins over the metadata.

**Approximate coordinates.** `db/coordenadas_aproximadas.csv` holds estimates made from each case's Localización,
with `radio_m` for how unsure they are; the map draws those cases as approximate. They are used only when a case
has neither a Coordenada nor photo GPS, so filling in a real Coordenada replaces them.

Errors (a malformed Identificador, Versión or Coordenada, two photos for the same version) stop the build.
Warnings (no Coordenada yet, a photo without a row, a place outside the map frame) don't.
Web copies of the photos are scaled to 2000 px and stripped of metadata, including GPS.

## Proposals from visitors

The map's **Contribuir al archivo** button lets anyone mark a place and bring one of three things: up to four photos
(with a description), an audio (recorded in the page or picked from a file, up to 40 MB) or a text. Photos are shrunk
in the browser; an audio is sent first in 2.5 MB pieces to `api/proponer-parte.js` (a function takes at most 4.5 MB
per request) and joined again on import. The proposal itself goes to `api/proponer.js`, which queues it in a **private** Vercel Blob store under
`propuestas/<id>/` (nothing reachable from the web; no contact details are collected). Nothing reaches the map until
the team adds it:

```sh
npm install                                             # once
npx vercel env pull .env.local                          # gets the store's credentials (again when they expire)
node --env-file=.env.local scripts/propuestas.mjs                    # list pending proposals
node --env-file=.env.local scripts/propuestas.mjs importar <id>      # download one to db/propuestas/<id>/
.venv/bin/python scripts/importar_propuesta.py db/propuestas/<id>    # next Identificador, rows, photos (--dry-run to preview)
.venv/bin/python scripts/build_archive.py                            # check it, then commit and push
node --env-file=.env.local scripts/propuestas.mjs borrar <id>        # remove it from the queue (also to reject)
node --env-file=.env.local scripts/propuestas.mjs limpiar            # now and then: audio pieces whose proposal never came
```

One-time setup: `npx vercel blob create-store lnu-propuestas --access private`, connected to the project.
Locally the form cannot send (the Python server has no functions); `npx vercel dev` runs it with the function.

## Running the site

The page loads its data with `fetch`, so serve it rather than opening the file:

```sh
.venv/bin/python scripts/build_archive.py
cd web && python3 -m http.server 8000      # http://localhost:8000
```

## Rebuilding the map data

The base layers are committed; rebuild them only when the sources change. All share the frame in `scripts/frame.py`.

| Script | Source | Output |
| --- | --- | --- |
| `buildings.py <gml>` | Catastro INSPIRE Buildings, `A.ES.SDGC.BU.28900.building.gml` | `web/data/buildings.json` |
| `trees.py <dir>` | Ayuntamiento de Madrid, `ARBOLADO_MADRID_7_7_26` shapefile (datos.madrid.es) | `web/data/trees.json` |
| `osm.py <out> <overpass.json...>` | Overpass API responses (parks, water) | `web/data/osm.json` |
| `ortho1956.py` | IGN WMS, Vuelo Americano Serie B 1956–57 (slow, resumable) | `web/tiles/1956/` |
| `places.py <overpass.json>` | OSM place nodes (districts, barrios, neighbourhoods, squares); query in the script | `web/data/places.json` (square names) |
| `palette_lab.py [--bundle]` | `web/data` | `palettes/data/crop.json` (+ `palettes/dist/index.html`) |
| `vegetation.py <images>` | street photos; needs `requirements-vegetation.txt` | `vegetation_out/` (Green View Index report) |

Sources: © Dirección General del Catastro; Ayuntamiento de Madrid; © OpenStreetMap contributors (ODbL);
orthophotos © Instituto Geográfico Nacional, CC BY 4.0.
