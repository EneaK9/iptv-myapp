// Local test server: serves viewer/ + /api/channels + /proxy (adds CORS, honors UA/Referer, rewrites HLS manifests)
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { normalizeStatus } from './status.mjs';
import { startRechecker, JOBS } from './rechecker.mjs';
import { isYouTube, resolveYouTubeLive, registerChannelIds } from './youtube.mjs';
import { isRakuten, rakutenId, rakutenLang, resolveRakuten } from './rakuten.mjs';
import { isResolver, resolveDynamic, refreshUrl } from './resolvers.mjs';
const headerSets = new Map(); // key -> { cookie, referer } for streams whose session must follow every request
const hkey = h => { const k = Buffer.from(JSON.stringify(h)).toString('base64url').slice(0, 24); headerSets.set(k, h); return k; };
try { registerChannelIds(JSON.parse(await readFile(new URL('../sources/official-youtube.json', import.meta.url), 'utf8'))); } catch {}

const PORT = Number(process.env.PORT ?? 8787);
const DATA = new URL('../data/', import.meta.url);
const VIEWER = new URL('../viewer/', import.meta.url);
const DEFAULT_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 TV Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const RECENT_MS = 48 * 3600 * 1000; // worked in the last 48 h: probably just off air for a while (many Albanian channels go dark for hours)
let channelsCache = null, health = {};
async function loadHealth() {
  try { return JSON.parse(await readFile(new URL('health.json', DATA), 'utf8')); }
  catch { // fresh checkout: health.json is git-ignored, so use the statuses baked into channels.checked.json
    const h = {};
    for (const c of JSON.parse(await readFile(new URL('channels.checked.json', DATA), 'utf8'))) for (const s of c.streams) if (s.health) h[s.url] = s.health;
    return h;
  }
}
// channels.json + health.json are read live and reloaded whenever either file changes (rechecker, npm run check/merge),
// so fresh statuses show up without re-running the report or restarting the server
let cacheStamp = '';
const dataStamp = async () => (await Promise.all(['channels.json', 'health.json'].map(f => stat(new URL(f, DATA)).then(s => s.mtimeMs, () => 0)))).join('|');
async function channels() {
  const stamp = await dataStamp();
  if (channelsCache && stamp === cacheStamp) return channelsCache;
  cacheStamp = stamp;
  const all = JSON.parse(await readFile(new URL('channels.json', DATA), 'utf8'));
  health = await loadHealth();
  channelsCache = all.map(c => {
    const streams = c.streams.map(s => {
      const h = health[s.url], status = h ? normalizeStatus(h.status) : null;
      return { url: s.url, quality: s.quality, labels: s.labels, ua: s.userAgent, ref: s.referrer, source: s.source,
        status, checkedAt: h?.checkedAt ?? null, lastOk: h?.lastOk ?? (status === 'ok' ? h.checkedAt : null) };
    });
    const alive = streams.some(s => s.status === 'ok');
    const recent = !alive && streams.some(s => s.lastOk && Date.now() - Date.parse(s.lastOk) < RECENT_MS);
    return { id: c.id, name: c.name, country: c.country, categories: c.categories, languages: c.languages, isNsfw: c.isNsfw, logo: c.logo, alive, recent, streams };
  });
  return channelsCache;
}

// the viewer reports every stream that actually started playing: it works now, whatever the last check said
const pendingMarks = new Map(); let saveTimer = null;
async function markWorked(u) {
  await channels();
  const now = new Date().toISOString();
  health[u] = { ...(health[u] ?? {}), status: 'ok', checkedAt: now, lastOk: now, via: 'viewer' };
  for (const c of channelsCache) for (const s of c.streams) if (s.url === u) { Object.assign(s, { status: 'ok', checkedAt: now, lastOk: now }); c.alive = true; c.recent = false; }
  pendingMarks.set(u, health[u]);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const marks = [...pendingMarks]; pendingMarks.clear();
    try { const onDisk = await loadHealth(); for (const [k, v] of marks) onDisk[k] = v; await writeFile(new URL('health.json', DATA), JSON.stringify(onDisk)); }
    catch (e) { console.error('health save failed:', e.message); }
  }, 1500);
}

// background rechecker (scripts/rechecker.mjs): Albanian every 30 min, new links hourly, everything daily; RECHECK=0 turns it off
const rechecker = startRechecker();

const proxied = (u, ua, ref, hk) => `/proxy?u=${encodeURIComponent(u)}${ua ? `&ua=${encodeURIComponent(ua)}` : ''}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}${hk ? `&h=${hk}` : ''}`;

function rewriteManifest(text, baseUrl, ua, ref, hk) {
  return text.replace(/\r/g, '').split('\n').map(line => {
    if (!line) return line;
    if (line.startsWith('#')) {
      // rewrite URI="..." inside EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF
      return line.replace(/URI="([^"]+)"/g, (_, u) => { try { return `URI="${proxied(new URL(u, baseUrl).href, ua, ref, hk)}"`; } catch { return _; } });
    }
    try { return proxied(new URL(line.trim(), baseUrl).href, ua, ref, hk); } catch { return line; }
  }).join('\n');
}

async function proxy(req, res, q) {
  let target = q.get('u'); let ua = q.get('ua') || DEFAULT_UA; let ref = q.get('ref') || '';
  let hk = q.get('h') || ''; let extra = hk ? (headerSets.get(hk) ?? {}) : {};
  if (target && isResolver(target)) {
    try { const r = await resolveDynamic(target); target = r.hls; extra = r.headers ?? {}; hk = hkey(extra); }
    catch (e) { res.writeHead(502, { 'access-control-allow-origin': '*', 'x-resolver-error': e.code || 'error' }); return res.end(`resolver: ${e.message}`); }
  }
  if (target && isRakuten(target)) {
    try { target = (await resolveRakuten(rakutenId(target), { lang: rakutenLang(target) })).hls; }
    catch (e) { res.writeHead(502, { 'access-control-allow-origin': '*', 'x-rakuten-error': e.code || 'error' }); return res.end(`rakuten: ${e.message}`); }
  }
  if (!target || !/^https?:/i.test(target)) { res.writeHead(400); return res.end('bad url'); }
  if (isYouTube(target)) {
    try { const r = await resolveYouTubeLive(target); target = r.hls; ua = IOS_UA; }
    catch (e) { res.writeHead(502, { 'access-control-allow-origin': '*', 'x-yt-error': e.code || 'error' }); return res.end(`youtube: ${e.message}`); }
  }
  try { target = await refreshUrl(target); } catch {}
  const headers = { 'user-agent': ua, accept: '*/*' };
  if (ref) { headers.referer = ref; try { headers.origin = new URL(ref).origin; } catch {} }
  if (extra.cookie) headers.cookie = extra.cookie;
  if (extra.referer && !ref) { headers.referer = extra.referer; try { headers.origin = new URL(extra.referer).origin; } catch {} }
  if (req.headers.range) headers.range = req.headers.range;
  let up;
  try { up = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) }); }
  catch (e) { res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end(`upstream error: ${e.message}`); }
  const ct = up.headers.get('content-type') ?? '';
  const finalUrl = up.url || target;
  const isManifest = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(finalUrl.split('#')[0]);
  const base = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', 'cache-control': 'no-store' };
  if (!up.ok) { res.writeHead(up.status, base); return res.end(); }
  if (isManifest) {
    const text = await up.text();
    if (!text.includes('#EXTM3U')) { res.writeHead(502, base); return res.end('not an HLS manifest'); }
    const body = rewriteManifest(text, finalUrl, q.get('ua') || '', ref, hk);
    res.writeHead(200, { ...base, 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end(body);
  }
  const h = { ...base, 'content-type': ct || 'application/octet-stream' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) if (up.headers.get(k)) h[k] = up.headers.get(k);
  res.writeHead(up.status, h);
  const reader = up.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (!res.write(value)) await new Promise(r => res.once('drain', r)); } }
  catch {} finally { res.end(); }
}

process.on('uncaughtException', e => console.error('uncaught', e));
process.on('unhandledRejection', e => console.error('rejection', e));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/proxy') return proxy(req, res, url.searchParams);
    if (url.pathname === '/api/channels') {
      const list = await channels();
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(list));
    }
    if (url.pathname === '/api/rechecker') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ lastRun: rechecker.lastRun, running: rechecker.running, everyMin: Object.fromEntries(Object.entries(JOBS).map(([n, j]) => [n, j.every / 60_000])) }));
    }
    if (url.pathname === '/api/played' && req.method === 'POST') {
      const u = url.searchParams.get('u');
      if (u) await markWorked(u);
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      return res.end();
    }
    if (url.pathname === '/tv' || url.pathname.startsWith('/tv/')) { // the TV app, for testing in a desktop browser (arrow keys = remote)
      const f = url.pathname.slice(4) || 'index.html';
      if (f.includes('..')) { res.writeHead(400); return res.end(); }
      const body = await readFile(f === 'tv.json' ? new URL('tv.json', DATA) : new URL(f, new URL('../tv/', import.meta.url)));
      res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
      return res.end(body);
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = await readFile(new URL(file, VIEWER));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(String(e.message));
  }
});
server.on('error', e => { console.error(e); process.exit(1); });
server.listen(PORT, () => console.log(`viewer: http://localhost:${PORT}`));
