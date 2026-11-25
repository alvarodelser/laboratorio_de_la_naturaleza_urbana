/* POST /api/proponer-parte: one piece of a proposed audio file. A function takes at most 4.5 MB per request, so the
   page cuts an audio into pieces of up to 2.5 MB, sends them here one by one, then sends the proposal itself to
   /api/proponer, which checks that every piece arrived. scripts/propuestas.mjs joins them back into one file.

   Body (JSON): {id: "YYYY-MM-DD-<16 hex>" (made by the page, the same for all pieces), i (0-based), n (pieces in all),
                 data: base64 of the piece}
   Pieces are stored privately as propuestas/<id>/audio-<ii>. Pieces whose proposal never arrives are removed by
   `node scripts/propuestas.mjs limpiar`. */
import { put } from '@vercel/blob';

export const ID = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{16}$/;
export const MAX_PARTS = 16, MAX_PART_BYTES = 2.5 * 1024 * 1024;   // 40 MB per audio
export const partName = (id, i) => `propuestas/${id}/audio-${String(i).padStart(2, '0')}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });
  const { id, i, n, data } = req.body || {};
  if (!ID.test(String(id)) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS || !Number.isInteger(i) || i < 0 || i >= n)
    return res.status(400).json({ error: 'Fragmento de audio no válido.' });
  const buf = /^[A-Za-z0-9+/=]+$/.test(String(data)) ? Buffer.from(data, 'base64') : null;
  if (!buf || !buf.length || buf.length > MAX_PART_BYTES) return res.status(400).json({ error: 'Fragmento de audio no válido.' });
  try {
    // overwriting is allowed so a piece can be resent after a dropped connection; the id is random and unguessable
    await put(partName(id, i), buf, { access: 'private', contentType: 'application/octet-stream', allowOverwrite: true });
  } catch (e) {
    console.error('proponer-parte:', e);
    return res.status(500).json({ error: 'No se pudo guardar el audio. Inténtalo más tarde.' });
  }
  return res.status(200).json({ ok: true });
}
