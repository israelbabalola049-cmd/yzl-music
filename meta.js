// Tiny tag reader (no npm needed): reads title / artist / album / cover art
// from mp3 (ID3v2 + ID3v1), flac and m4a files.
const fs = require('fs');

const rd = async (fh, pos, len) => {
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead < len ? buf.subarray(0, bytesRead) : buf;
};
const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const unsync = b => Buffer.from(b.toString('binary').replace(/\xFF\x00/g, '\xFF'), 'binary');
const even = b => (b.length % 2 ? b.subarray(0, b.length - 1) : b);

function decode(buf, enc) {
  if (!buf.length) return '';
  if (enc === 1) {
    if (buf[0] === 0xFE && buf[1] === 0xFF) return Buffer.from(even(buf.subarray(2))).swap16().toString('utf16le');
    if (buf[0] === 0xFF && buf[1] === 0xFE) return even(buf.subarray(2)).toString('utf16le');
    return even(buf).toString('utf16le');
  }
  if (enc === 2) return Buffer.from(even(buf)).swap16().toString('utf16le');
  if (enc === 3) return buf.toString('utf8');
  return buf.toString('latin1');
}

function findTerm(b, p, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = p; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
    return b.length;
  }
  const i = b.indexOf(0, p);
  return i < 0 ? b.length : i + 1;
}

function sniffImage(d) {
  if (d[0] === 0x89 && d[1] === 0x50) return 'png';
  if (d[0] === 0x47 && d[1] === 0x49) return 'gif';
  if (d.toString('latin1', 0, 4) === 'RIFF' && d.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return 'jpg';
}

function textFrame(data, join) {
  const parts = decode(data.subarray(1), data[0]).split('\0').map(s => s.replace(/^\uFEFF/, '').trim()).filter(Boolean);
  return join ? parts.join(', ') : (parts[0] || '');
}

// ---------- MP3 (ID3v2) ----------
async function readID3(fh, wantPic) {
  const h = await rd(fh, 0, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = h[3], flags = h[5], end = 10 + synchsafe(h, 6);
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  let p = 10;
  if (flags & 0x40 && ver >= 3) {
    const e = await rd(fh, p, 4);
    p += ver === 4 ? synchsafe(e, 0) : e.readUInt32BE(0) + 4;
  }
  const map = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TPE2: 'albumArtist', TP2: 'albumArtist', TYER: 'year', TYE: 'year', TDRC: 'year', TDRL: 'year', TRCK: 'track', TRK: 'track', TCON: 'genre', TCO: 'genre' };
  const out = {}; let picType = -1;
  while (p + hdrLen <= end) {
    const fhd = await rd(fh, p, hdrLen);
    const id = fhd.toString('latin1', 0, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let size, fl = 0;
    if (ver === 2) size = fhd.readUIntBE(3, 3);
    else { size = ver === 4 ? synchsafe(fhd, 4) : fhd.readUInt32BE(4); fl = fhd.readUInt16BE(8); }
    p += hdrLen;
    if (size <= 0 || p + size > end) break;
    const body = p; p += size;
    if (ver === 3 && (fl & 0x00C0)) continue;            // compressed / encrypted: skip
    const key = map[id];
    if (key && !out[key] && size < 4096) {
      let d = await rd(fh, body, size);
      if (ver === 4 && (fl & 1)) d = d.subarray(4);
      if (ver === 4 && (fl & 2)) d = unsync(d);
      out[key] = textFrame(d, key === 'artist' || key === 'albumArtist');
    } else if (wantPic && (id === 'APIC' || id === 'PIC') && size < 30e6) {
      let d = await rd(fh, body, size);
      if (ver === 4 && (fl & 1)) d = d.subarray(4);
      if (ver === 4 && (fl & 2)) d = unsync(d);
      const enc = d[0]; let q = 1;
      if (ver === 2) q += 3; else q = d.indexOf(0, q) + 1;
      const type = d[q]; q += 1;
      q = findTerm(d, q, enc);
      const data = d.subarray(q);
      if (data.length > 100 && (!out.pic || (type === 3 && picType !== 3))) { out.pic = { data, ext: sniffImage(data) }; picType = type; }
    }
    if (!wantPic && out.title && out.artist && out.album && out.year && out.track && out.genre) break;
    if (wantPic && picType === 3) break;
  }
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  return out;
}

async function readID3v1(fh, size) {
  if (size < 128) return null;
  const b = await rd(fh, size - 128, 128);
  if (b.toString('latin1', 0, 3) !== 'TAG') return null;
  const f = (a, z) => b.toString('latin1', a, z).replace(/\0[\s\S]*$/, '').trim();
  return { title: f(3, 33), artist: f(33, 63), album: f(63, 93), year: f(93, 97), track: (b[125] === 0 && b[126]) ? b[126] : undefined };
}

// ---------- FLAC ----------
async function readFlac(fh, wantPic) {
  let p = 4; const out = {}; let picType = -1;
  for (;;) {
    const h = await rd(fh, p, 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = h.readUIntBE(1, 3);
    p += 4;
    if (type === 4 && len < 1e6) {
      const b = await rd(fh, p, len);
      let o = 4 + b.readUInt32LE(0);
      const n = b.readUInt32LE(o); o += 4;
      for (let i = 0; i < n && o + 4 <= b.length; i++) {
        const l = b.readUInt32LE(o); o += 4;
        const s = b.toString('utf8', o, o + l); o += l;
        const k = s.indexOf('=');
        if (k < 0) continue;
        const key = s.slice(0, k).toUpperCase(), val = s.slice(k + 1).trim();
        if (key === 'TITLE' && !out.title) out.title = val;
        if (key === 'ARTIST' && !out.artist) out.artist = val;
        if (key === 'ALBUM' && !out.album) out.album = val;
        if ((key === 'DATE' || key === 'YEAR') && !out.year) out.year = val;
        if (key === 'TRACKNUMBER' && !out.track) out.track = val;
        if ((key === 'TRACKTOTAL' || key === 'TOTALTRACKS') && !out.trackTotal) out.trackTotal = val;
        if (key === 'ALBUMARTIST' && !out.albumArtist) out.albumArtist = val;
        if (key === 'GENRE' && !out.genre) out.genre = val;
      }
    } else if (type === 6 && wantPic && len < 30e6) {
      const b = await rd(fh, p, len);
      const t = b.readUInt32BE(0);
      let o = 8 + b.readUInt32BE(4);
      o += 4 + b.readUInt32BE(o);
      o += 16;
      const dl = b.readUInt32BE(o); o += 4;
      const data = b.subarray(o, o + dl);
      if (data.length > 100 && (!out.pic || (t === 3 && picType !== 3))) { out.pic = { data, ext: sniffImage(data) }; picType = t; }
    }
    p += len;
    if (last) break;
  }
  return out;
}

// ---------- M4A / MP4 ----------
function* atoms(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let sz = buf.readUInt32BE(p), hdr = 8;
    const name = buf.toString('latin1', p + 4, p + 8);
    if (sz === 1) { sz = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (sz === 0) sz = end - p;
    if (sz < hdr || p + sz > end) return;
    yield { name, start: p + hdr, end: p + sz };
    p += sz;
  }
}
const child = (buf, s, e, name) => { for (const a of atoms(buf, s, e)) if (a.name === name) return a; return null; };

async function readM4a(fh, size, wantPic) {
  let p = 0; const out = {};
  while (p + 8 <= size) {
    const h = await rd(fh, p, 16);
    let sz = h.readUInt32BE(0), hdr = 8;
    const name = h.toString('latin1', 4, 8);
    if (sz === 1) { sz = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (sz === 0) sz = size - p;
    if (sz < 8) break;
    if (name === 'moov' && sz < 32e6) {
      const m = await rd(fh, p + hdr, sz - hdr);
      const udta = child(m, 0, m.length, 'udta'); if (!udta) return out;
      const meta = child(m, udta.start, udta.end, 'meta'); if (!meta) return out;
      const ilst = child(m, meta.start + 4, meta.end, 'ilst'); if (!ilst) return out;
      for (const it of atoms(m, ilst.start, ilst.end)) {
        const d = child(m, it.start, it.end, 'data'); if (!d) continue;
        const payload = m.subarray(d.start + 8, d.end);
        if (it.name === '\u00A9nam') out.title = payload.toString('utf8').trim();
        else if (it.name === '\u00A9ART') out.artist = payload.toString('utf8').trim();
        else if (it.name === '\u00A9alb') out.album = payload.toString('utf8').trim();
        else if (it.name === '\u00A9day') out.year = payload.toString('utf8').trim();
        else if (it.name === 'trkn' && payload.length >= 4) { out.track = payload.readUInt16BE(2); if (payload.length >= 6) out.trackTotal = payload.readUInt16BE(4); }
        else if (it.name === '\u00A9gen') out.genre = payload.toString('utf8').trim();
        else if (it.name === 'aART' && !out.albumArtist) out.albumArtist = payload.toString('utf8').trim();
        else if (it.name === 'covr' && wantPic && payload.length > 100) out.pic = { data: payload, ext: sniffImage(payload) };
      }
      if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
      return out;
    }
    p += sz;
  }
  return out;
}

function fixNums(o) {
  if (o.genre != null) { const g = String(o.genre).replace(/^(\(\d+\))+/, '').replace(/\0[\s\S]*$/, '').trim(); o.genre = g && !/^\d+$/.test(g) ? g : undefined; }
  if (o.year != null) { const m = String(o.year).match(/\d{4}/); o.year = m ? +m[0] : undefined; }
  if (o.track != null) {
    const m = String(o.track).match(/\/\s*(\d+)/);
    if (m && !o.trackTotal) o.trackTotal = +m[1];
    const n = parseInt(o.track, 10); o.track = n > 0 ? n : undefined;
  }
  if (o.trackTotal != null) { const t = parseInt(o.trackTotal, 10); o.trackTotal = t > 0 && t < 200 ? t : undefined; }
  return o;
}

async function readMeta(file, wantPic = false) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const head = await rd(fh, 0, 12);
    let m = null;
    if (head.toString('latin1', 0, 3) === 'ID3') m = await readID3(fh, wantPic);
    else if (head.toString('latin1', 0, 4) === 'fLaC') m = await readFlac(fh, wantPic);
    else if (head.toString('latin1', 4, 8) === 'ftyp') m = await readM4a(fh, size, wantPic);
    if (!m || (!m.title && !m.artist)) {
      const v1 = await readID3v1(fh, size);
      if (v1) m = { ...(m || {}), ...Object.fromEntries(Object.entries(v1).filter(([, v]) => v)) };
    }
    return fixNums(m || {});
  } catch (e) {
    return {};
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { readMeta };
