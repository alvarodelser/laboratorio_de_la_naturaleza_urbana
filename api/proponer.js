/* POST /api/proponer: a visitor proposes a case: photos, an audio or a text. It is queued in Vercel Blob under
   propuestas/<id>/ (caso.json and its files) until the team reviews it with scripts/propuestas.mjs and adds it to db/
   with scripts/importar_propuesta.py.

   Body (JSON, under Vercel's 4.5 MB limit: the page shrinks photos, and sends an audio beforehand in pieces):
     {tipo: 'foto' | 'audio' | 'texto', titulo, fecha?, fuente?, nombre?, lat, lon, radio (m, 0 = exact),
      foto:  descripcion, fotos: [data:image/jpeg;base64,...] (1-4);
             or a linked pair (the same view then and now): fotos: [antes, ahora], vinculadas: true, anos: [año antes, año ahora]
      audio: descripcion?, audio: {id, partes, ext, bytes}: the pieces already sent to /api/proponer-parte under that id
      texto: texto (up to 8000 characters, paragraphs kept)
      web (honeypot: must stay empty)}
   Needs a private Blob store connected to the project (Vercel then provides the credentials). Proposals are private:
   nothing is reachable from the web until the team publishes it. No contact details are collected. */
import { put, list } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { ID, MAX_PARTS, partName } from './proponer-parte.js';

const FRAME = { lat: [40.33, 40.51], lon: [-3.79, -3.59] };   // Madrid, map frame plus a margin
const MAX_PHOTOS = 4, MAX_PHOTO_BYTES = 1.2e6, MAX_TEXT = 8000;
const AUDIO_EXT = ['webm', 'ogg', 'opus', 'm4a', 'mp4', 'mp3', 'wav', 'aac', 'amr', '3gp', 'caf', 'flac'];
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// a text keeps its paragraphs: spaces tidied within lines, at most one blank line between paragraphs
const cleanText = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });
  const b = req.body || {};
  if (b.web) return res.status(200).json({ ok: true });          // a bot filled the hidden field: drop silently

  const tipo = ['foto', 'audio', 'texto'].includes(b.tipo) ? b.tipo : 'foto';
  const caso = {
    tipo, titulo: clean(b.titulo, 140), fecha: clean(b.fecha, 40), descripcion: clean(b.descripcion, 2000),
    fuente: clean(b.fuente, 200), nombre: clean(b.nombre, 80),
    lat: Number(b.lat), lon: Number(b.lon), radio: Math.max(0, Math.min(3000, Math.round(Number(b.radio) || 0))),
  };
  const errors = [];
  if (!caso.titulo) errors.push('Falta el título.');
  if (!(caso.lat > FRAME.lat[0] && caso.lat < FRAME.lat[1] && caso.lon > FRAME.lon[0] && caso.lon < FRAME.lon[1]))
    errors.push('La ubicación está fuera del mapa.');

  let id = new Date().toISOString().slice(0, 10) + '-' + randomUUID().slice(0, 8);
  const images = [];
  if (tipo === 'foto') {
    if (!caso.descripcion) errors.push('Falta la descripción.');
    const fotos = Array.isArray(b.fotos) ? b.fotos.slice(0, MAX_PHOTOS) : [];
    if (!fotos.length) errors.push('Añade al menos una foto.');
    if (b.vinculadas) {
      if (fotos.length !== 2) errors.push('Una pareja antes y ahora lleva dos fotos.');
      caso.vinculadas = true;
      caso.anos = [0, 1].map(i => clean(Array.isArray(b.anos) ? b.anos[i] : '', 40));
    }
    for (const f of fotos) {
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(f));
      const buf = m && Buffer.from(m[1], 'base64');
      if (!buf || buf.length > MAX_PHOTO_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) { errors.push('Alguna foto no es válida.'); break; }
      images.push(buf);
    }
  } else if (tipo === 'texto') {
    caso.texto = cleanText(b.texto, MAX_TEXT);
    if (!caso.texto) errors.push('Falta el texto.');
  } else {
    const a = b.audio || {}, n = a.partes, ext = String(a.ext || '').toLowerCase();
    if (!ID.test(String(a.id)) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS || !AUDIO_EXT.includes(ext)) errors.push('Falta el audio o no es válido.');
    else {
      id = a.id;   // the pieces are already in this proposal's folder
      try {
        const { blobs } = await list({ prefix: `propuestas/${id}/audio-`, limit: 100 });
        const have = new Set(blobs.map(x => x.pathname));
        if (!Array.from({ length: n }, (_, i) => partName(id, i)).every(p => have.has(p))) errors.push('El audio no llegó completo. Vuelve a enviarlo.');
        caso.audio = { partes: Array.from({ length: n }, (_, i) => partName(id, i)), ext, bytes: blobs.reduce((s, x) => s + x.size, 0) };
      } catch (e) {
        console.error('proponer (audio):', e);
        return res.status(500).json({ error: 'No se pudo comprobar el audio. Inténtalo más tarde.' });
      }
    }
  }
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  try {
    caso.fotos = [];
    for (const [i, buf] of images.entries()) {
      const name = `propuestas/${id}/${'abcd'[i]}.jpg`;
      await put(name, buf, { access: 'private', contentType: 'image/jpeg' });
      caso.fotos.push(name);
    }
    caso.id = id; caso.recibido = new Date().toISOString();
    // not overwritable: a proposal is sent once
    await put(`propuestas/${id}/caso.json`, JSON.stringify(caso, null, 1), { access: 'private', contentType: 'application/json' });
  } catch (e) {
    console.error('proponer:', e);
    return res.status(500).json({ error: 'No se pudo guardar la propuesta. Inténtalo más tarde.' });
  }
  return res.status(200).json({ ok: true, id });
}
