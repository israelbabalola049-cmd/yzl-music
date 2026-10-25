const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const http = require('http');
const { readMeta } = require('./meta');

// App name + keep saving data in the same place as before (so your folder and playlists survive the rename)
app.setName("YZL Music");
app.setPath('userData', path.join(app.getPath('appData'), 'my-music-player'));
app.setAppUserModelId('com.yzl.music');   // Windows uses this to group the taskbar icon and show the right name

const APP_ICON = path.join(__dirname, 'build', 'icon.ico');

const AUDIO = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.opus'];
const userFile = name => path.join(app.getPath('userData'), name);

// Tiny local file server (127.0.0.1 only, random port, secret token, only serves audio inside your music folder).
// Songs play from http:// instead of file:// so the equaliser is allowed to process them (Chromium mutes
// file:// audio the moment it is routed through Web Audio).
const mediaToken = crypto.randomBytes(12).toString('hex');
let mediaPort = 0, libRoot = '';
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.opus': 'audio/ogg' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length' };
const mediaServer = http.createServer((req, res) => {
  const fail = code => { res.writeHead(code, CORS); res.end(); };
  if (req.method === 'OPTIONS') return fail(204);
  try {
    const parts = req.url.split('?')[0].split('/');
    if (parts[1] !== mediaToken) return fail(403);
    const file = path.resolve(decodeURIComponent(parts.slice(2).join('/')));
    const root = path.resolve(libRoot || '\0');
    if (!libRoot || !file.toLowerCase().startsWith((root + path.sep).toLowerCase())) return fail(403);
    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext]) return fail(403);
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, code = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = +r[1]; if (r[2]) end = Math.min(+r[2], size - 1); }
      else { start = Math.max(0, size - +r[2]); }
      if (start > end || start >= size) { res.writeHead(416, { ...CORS, 'Content-Range': 'bytes */' + size }); return res.end(); }
      code = 206;
    }
    const h = { ...CORS, 'Content-Type': MIME[ext], 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(file, { start, end });
    s.on('error', () => res.destroy());
    res.on('close', () => s.destroy());
    s.pipe(res);
  } catch { fail(404); }
});

function loadJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJSON(file, data) { try { fs.writeFileSync(file, JSON.stringify(data)); } catch {} }

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (AUDIO.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

// Turn a messy file name into something readable
function cleanName(file) {
  let n = path.parse(file).name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/[\s-]*\S+\.(com|net|ng|org|co)\s*$/i, '').trim();
  return n;
}

function makeSong(file, meta) {
  let title = (meta.title || '').trim();
  let artist = (meta.artist || '').trim();
  const album = (meta.album || '').trim();
  if (!title) {
    title = cleanName(file);
    if (!artist && title.includes(' - ')) {
      const i = title.indexOf(' - ');
      artist = title.slice(0, i).trim();
      title = title.slice(i + 3).trim();
    }
  }
  return { path: file, url: `http://127.0.0.1:${mediaPort}/${mediaToken}/${encodeURIComponent(file)}`, title, artist: artist || 'Unknown Artist', album: album || 'Unknown Album', year: meta.year || null, track: meta.track || null, albumArtist: (meta.albumArtist || '').trim() || null, trackTotal: meta.trackTotal || null, genre: (meta.genre || '').trim() || null };
}

async function scan(folder) {
  libRoot = folder;
  const files = walk(folder);
  const cacheFile = userFile('library-cache-v4.json');
  const cache = loadJSON(cacheFile, {});
  const next = {};
  const songs = new Array(files.length);
  let i = 0;
  async function worker() {
    while (i < files.length) {
      const idx = i++;
      const f = files[idx];
      let st;
      try { st = await fs.promises.stat(f); } catch { continue; }
      const c = cache[f];
      let meta;
      if (c && c.m === st.mtimeMs && c.s === st.size) meta = c.meta;
      else meta = await readMeta(f, false);
      next[f] = { m: st.mtimeMs, s: st.size, meta: { title: meta.title, artist: meta.artist, album: meta.album, year: meta.year, track: meta.track, albumArtist: meta.albumArtist, trackTotal: meta.trackTotal, genre: meta.genre } };
      songs[idx] = makeSong(f, meta);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  saveJSON(cacheFile, next);
  return songs.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

// Cover art: pulled out of the file once, saved as a small image file, then reused
const coverMemo = new Map();
async function coverFor(file) {
  if (coverMemo.has(file)) return coverMemo.get(file);
  let url = null;
  try {
    const meta = await readMeta(file, true);
    if (meta.pic) {
      const dir = userFile('covers');
      fs.mkdirSync(dir, { recursive: true });
      const name = crypto.createHash('sha1').update(meta.pic.data).digest('hex').slice(0, 20) + '.' + meta.pic.ext;
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) fs.writeFileSync(full, meta.pic.data);
      url = pathToFileURL(full).href;
    }
  } catch {}
  coverMemo.set(file, url);
  return url;
}

// ---------- artist info: short bio (Wikipedia) + photo and similar artists (Deezer) ----------
// Looked up once per artist, saved on your laptop, so it works offline afterwards.
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function getBuf(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'YZLMusic/0.5 (personal music player)', 'Accept': 'application/json,image/*' }, timeout: 8000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 4) { res.resume(); return resolve(getBuf(new URL(res.headers.location, url).href, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); const e = new Error('HTTP ' + res.statusCode); e.status = res.statusCode; return reject(e); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const getJSON = async url => JSON.parse((await getBuf(url)).toString('utf8'));
async function cacheImg(url) {
  try {
    const dir = userFile('artist-images');
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, crypto.createHash('sha1').update(url).digest('hex').slice(0, 20) + '.jpg');
    if (!fs.existsSync(full)) fs.writeFileSync(full, await getBuf(url));
    return pathToFileURL(full).href;
  } catch { return null; }
}
const MUSICY = /singer|rapper|musician|songwriter|producer|band|group|duo|vocalist|disc jockey|\bDJ\b|composer|recording artist/i;
async function wikiBio(name) {
  // "Drake" alone is a duck, so also try "(musician)", "(singer)" ... and only accept a page that is about a music artist
  for (const t of [name, name + ' (musician)', name + ' (singer)', name + ' (rapper)', name + ' (band)']) {
    let j;
    try { j = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_'))); }
    catch (e) { if (e.status === 404) continue; throw e; }
    if (j.type !== 'standard' || !j.extract) continue;
    if (!MUSICY.test(j.description || '')) continue;
    if (norm(String(j.title).replace(/\s*\(.*\)\s*$/, '')) !== norm(name)) continue;
    return { bio: j.extract, desc: j.description || '', url: j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page, thumb: j.thumbnail && j.thumbnail.source };
  }
  return null;
}
async function deezerInfo(name) {
  const s = await getJSON('https://api.deezer.com/search/artist?limit=5&q=' + encodeURIComponent(name));
  const a = (s.data || []).find(x => norm(x.name) === norm(name));
  if (!a) return null;
  const good = u => u && !u.includes('/artist//');
  const r = await getJSON('https://api.deezer.com/artist/' + a.id + '/related?limit=10');
  return { pic: good(a.picture_xl) ? a.picture_xl : (good(a.picture_big) ? a.picture_big : null),
           similar: (r.data || []).slice(0, 5).map(x => ({ name: x.name, pic: good(x.picture_medium) ? x.picture_medium : null })) };
}
let infoCache = null; const infoBusy = new Map();
async function lookupArtist(name, prev) {
  let wOk = true, dOk = true;
  const [w, d] = await Promise.all([wikiBio(name).catch(() => { wOk = false; return null; }), deezerInfo(name).catch(() => { dOk = false; return null; })]);
  if (!wOk && !dOk) return prev || { t: 0 };            // no internet: keep what we already have, change nothing
  const out = Object.assign({}, prev || {}); out.t = Date.now();
  if (wOk) { out.wOk = true; if (w) { out.bio = w.bio; out.desc = w.desc; out.wiki = w.url; } }
  if (dOk) out.dOk = true;
  const pic = (d && d.pic) || (w && w.thumb);
  if (pic) { const p = await cacheImg(pic); if (p) out.photo = p; }
  if (d && d.similar.length) out.similar = await Promise.all(d.similar.map(async s => ({ name: s.name, pic: s.pic ? await cacheImg(s.pic) : null })));
  infoCache[name] = out; saveJSON(userFile('artist-info.json'), infoCache);
  return out;
}
ipcMain.handle('artist-info', (e, name) => {
  name = String(name || '').trim();
  if (!name || name === 'Unknown Artist') return null;
  if (!infoCache) infoCache = loadJSON(userFile('artist-info.json'), {});
  const c = infoCache[name];
  if (c) {
    // saved copy is always used straight away (works offline); if it is old or half-finished we top it up quietly in the background
    const has = c.bio || c.photo || (c.similar && c.similar.length), age = Date.now() - c.t;
    const fresh = (c.wOk && c.dOk) ? age < (has ? 30 : 3) * 864e5 : age < 36e5;
    if (!fresh && !infoBusy.has(name)) infoBusy.set(name, lookupArtist(name, c).catch(() => c).finally(() => infoBusy.delete(name)));
    return c;
  }
  if (!infoBusy.has(name)) infoBusy.set(name, lookupArtist(name, null).finally(() => infoBusy.delete(name)));
  return infoBusy.get(name);
});
ipcMain.handle('open-link', (e, url) => { try { const u = new URL(url); if (u.protocol === 'https:' && /(^|\.)wikipedia\.org$/.test(u.hostname)) shell.openExternal(u.href); } catch {} });

// ---------- miniplayer: a small always-on-top window; the real player window hides while it is open ----------
let mainWin = null, miniWin = null, miniLast = null, miniLayout = 'card', miniDrag = null;
const MINI_SIZE = { card: { w: 364, h: 516 }, bar: { w: 444, h: 156 } };   // includes 32px around the card so its soft shadow fades out completely
const miniFile = () => userFile('miniplayer.json');
const alive = w => w && !w.isDestroyed();
function saveMiniPos() { if (!alive(miniWin)) return; const b = miniWin.getBounds(); saveJSON(miniFile(), { x: b.x, y: b.y, layout: miniLayout }); }
function openMini() {
  if (!alive(mainWin) || alive(miniWin)) return;
  const saved = loadJSON(miniFile(), {});
  miniLayout = saved.layout === 'bar' ? 'bar' : 'card';
  const sz = MINI_SIZE[miniLayout];
  let x = saved.x, y = saved.y;
  const onScreen = Number.isFinite(x) && Number.isFinite(y) && screen.getAllDisplays().some(d => x + 60 > d.workArea.x && x < d.workArea.x + d.workArea.width - 60 && y >= d.workArea.y - 8 && y < d.workArea.y + d.workArea.height - 60);
  if (!onScreen) { const wa = screen.getDisplayMatching(mainWin.getBounds()).workArea; x = wa.x + wa.width - sz.w - 16; y = wa.y + wa.height - sz.h - 16; }
  miniWin = new BrowserWindow({
    x, y, width: sz.w, height: sz.h, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, show: false, title: 'YZL Music',
    icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.loadFile('miniplayer.html', { query: { l: miniLayout } });
  miniWin.once('ready-to-show', () => { if (!alive(miniWin)) return; miniWin.show(); if (alive(mainWin)) mainWin.hide(); });
  miniWin.on('closed', () => {
    miniWin = null; miniDrag = null;
    if (alive(mainWin)) { mainWin.show(); mainWin.focus(); mainWin.webContents.send('mini-closed'); }
  });
}
ipcMain.on('set-chrome', (e, color) => { if (alive(mainWin) && /^#[0-9a-f]{6}$/i.test(color) && mainWin.setTitleBarOverlay) { try { mainWin.setTitleBarOverlay({ color, symbolColor: '#ffffff', height: 36 }); } catch {} } });
ipcMain.handle('mini-open', (e, state) => { miniLast = state; openMini(); });
ipcMain.on('mini-state', (e, st) => {
  miniLast = Object.assign(miniLast || {}, st);
  if (alive(miniWin) && !miniWin.webContents.isLoading()) miniWin.webContents.send('mini-state', st);
});
ipcMain.on('mini-ready', e => { if (miniLast) e.sender.send('mini-state', miniLast); });
ipcMain.on('mini-cmd', (e, cmd, arg) => { if (['toggle', 'next', 'prev', 'seek'].includes(cmd) && alive(mainWin)) mainWin.webContents.send('mini-cmd', cmd, arg); });
ipcMain.on('mini-expand', () => { if (alive(miniWin)) { saveMiniPos(); miniWin.close(); } });
ipcMain.handle('mini-layout', (e, layout) => {
  if (!alive(miniWin)) return;
  miniLayout = layout === 'bar' ? 'bar' : 'card';
  const b = miniWin.getBounds(), sz = MINI_SIZE[miniLayout], wa = screen.getDisplayMatching(b).workArea;
  const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - sz.w)), y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - sz.h));
  miniWin.setBounds({ x, y, width: sz.w, height: sz.h });
  saveMiniPos();
});
ipcMain.on('mini-drag-start', () => { if (alive(miniWin)) { const b = miniWin.getBounds(); miniDrag = { x: b.x, y: b.y, w: b.width, h: b.height }; } });
ipcMain.on('mini-drag', (e, dx, dy) => { if (alive(miniWin) && miniDrag) miniWin.setBounds({ x: Math.round(miniDrag.x + dx), y: Math.round(miniDrag.y + dy), width: miniDrag.w, height: miniDrag.h }); });
ipcMain.on('mini-drag-end', () => { miniDrag = null; saveMiniPos(); });

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 740,
    minWidth: 900, minHeight: 560,
    backgroundColor: '#0b0e15',
    title: 'YZL Music',
    icon: APP_ICON,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0e15', symbolColor: '#ffffff', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  mainWin = win;
  win.on('closed', () => { mainWin = null; if (alive(miniWin)) miniWin.destroy(); });
  win.loadFile('index.html');
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled) return null;
  saveJSON(userFile('settings.json'), { folder: r.filePaths[0] });
  return { folder: r.filePaths[0], songs: await scan(r.filePaths[0]) };
});

ipcMain.handle('load-saved', async () => {
  const { folder } = loadJSON(userFile('settings.json'), {});
  if (!folder || !fs.existsSync(folder)) return null;
  return { folder, songs: await scan(folder) };
});

// switch the whole window between the normal player and the DJ page
ipcMain.handle('switch-mode', (e, mode) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.loadFile(mode === 'dj' ? 'disc-jockey.html' : 'index.html'); });

ipcMain.handle('get-cover', (e, file) => coverFor(file));

// Used for both "change artist photo" and "change song cover" - user picks any image
// on their laptop, we copy it into our own folder (so it keeps working even if they
// later move or delete the original file) and hand back a stable link to it.
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'jfif', 'jpe', 'pjpeg', 'pjp', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0];
  const dir = userFile('custom-images');
  fs.mkdirSync(dir, { recursive: true });
  let ext = path.extname(src).toLowerCase() || '.jpg';
  if (['.jfif', '.jpe', '.pjpeg', '.pjp'].includes(ext)) ext = '.jpg';   // same JPEG data, just an extension Chromium always understands
  const name = crypto.randomBytes(10).toString('hex') + ext;
  const dest = path.join(dir, name);
  fs.copyFileSync(src, dest);
  return pathToFileURL(dest).href;
});

// Only one copy of the app at a time: opening it again just brings the existing window forward
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = alive(miniWin) ? miniWin : mainWin;
    if (alive(w)) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
  app.whenReady()
    .then(() => new Promise(r => mediaServer.listen(0, '127.0.0.1', () => { mediaPort = mediaServer.address().port; r(); })))
    .then(() => {
      if (app.isPackaged) Menu.setApplicationMenu(null);   // no File/Edit/View menu in the installed app (dev keeps it for DevTools)
      createWindow();
    });
}
app.on('window-all-closed', () => app.quit());
