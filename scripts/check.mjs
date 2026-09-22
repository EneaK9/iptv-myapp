// Concurrent HTTP-level liveness check of every stream URL in data/channels.json.
// For HLS: GET manifest -> if master, follow first variant -> media playlist must list segments ->
// fetch first bytes of first segment. Writes data/health.json {url: result} and appends progress to data/check.log.
import { readFile, writeFile } from 'node:fs/promises';
import { classifyError } from './status.mjs';
import { isYouTube, resolveYouTubeLive, registerChannelIds } from './youtube.mjs';
import { isRakuten, rakutenId, rakutenLang, resolveRakuten } from './rakuten.mjs';
import { isResolver, resolveDynamic } from './resolvers.mjs';
try { registerChannelIds(JSON.parse(await readFile(new URL('../sources/official-youtube.json', import.meta.url), 'utf8'))); } catch {}

const DATA = new URL('../data/', import.meta.url);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 48);
const TIMEOUT = Number(process.env.TIMEOUT ?? 12_000);
const ONLY = process.env.ONLY; // e.g. ONLY=AL,XK  -> only channels of these countries
const MATCH = process.env.MATCH ? new RegExp(process.env.MATCH, 'i') : null; // e.g. MATCH=youtube -> only URLs matching
const NEW_ONLY = process.env.NEW_ONLY === '1'; // only URLs with no previous result in health.json
const DEFAULT_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 TV Safari/537.36';

const channels = JSON.parse(await readFile(new URL('channels.json', DATA), 'utf8'));
let previous = {};
try { previous = JSON.parse(await readFile(new URL('health.json', DATA), 'utf8')); } catch {}

const jobs = [];
const seen = new Set();
for (const c of channels) {
  if (ONLY && !ONLY.split(',').includes(c.country ?? '')) continue;
  for (const s of c.streams) {
    if (seen.has(s.url)) continue;
    if (MATCH && !MATCH.test(s.url)) continue;
    if (NEW_ONLY && previous[s.url]) continue;
    seen.add(s.url);
    jobs.push({ url: s.url, ua: s.userAgent, ref: s.referrer, labels: s.labels, channel: c.id });
  }
}
console.log(`checking ${jobs.length} unique stream URLs, concurrency ${CONCURRENCY}, timeout ${TIMEOUT}ms`);

const results = {};
// classifyError lives in status.mjs

async function get(url, headers, { maxBytes = 512 * 1024, range } = {}) {
  const h = { 'user-agent': headers.ua || DEFAULT_UA, accept: '*/*' };
  if (headers.ref) { h.referer = headers.ref; h.origin = new URL(headers.ref).origin; }
  if (headers.cookie) h.cookie = headers.cookie;
  if (range) h.range = range;
  const res = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok || !res.body) { res.body?.cancel().catch(() => {}); return { res, body: Buffer.alloc(0) }; }
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  while (n < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length;
  }
  reader.cancel().catch(() => {});
  return { res, body: Buffer.concat(chunks) };
}

let ytChain = Promise.resolve(); const YT_SPACING_MS = Number(process.env.YT_SPACING_MS ?? 2500);
const ytGate = () => { const p = ytChain.then(() => new Promise(r => setTimeout(r, YT_SPACING_MS))); ytChain = p.catch(() => {}); return p; };
const resolveUrl = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };
const isHls = (body, ct) => body?.subarray(0, 32).toString().includes('#EXTM3U') || /mpegurl/i.test(ct);

async function checkOne(job) {
  const t0 = Date.now();
  const out = { status: 'unknown', http: null, ms: 0, kind: null, channel: job.channel, checkedAt: new Date().toISOString() };
  try {
    let url = job.url;
    if (isResolver(url)) {
      try { const r = await resolveDynamic(url); url = r.hls; out.kind = 'session'; job = { ...job, ref: r.headers?.referer ?? job.ref, cookie: r.headers?.cookie ?? null }; }
      catch (e) { out.status = e.code || 'resolver_error'; return out; }
    } else if (isRakuten(url)) {
      try { const r = await resolveRakuten(rakutenId(url), { lang: rakutenLang(url) }); url = r.hls; out.kind = 'rakuten'; }
      catch (e) { out.status = e.code || 'rakuten_error'; return out; }
    } else if (!/^https?:/i.test(url)) { out.status = 'unsupported_scheme'; return out; }
    if (isYouTube(url)) {
      await ytGate();                                   // one YouTube page fetch at a time, spaced out
      try { const r = await resolveYouTubeLive(url); url = r.hls; out.kind = 'youtube'; out.title = r.title; }
      catch (e) {
        out.status = e.code || 'yt_error';
        if (out.status === 'yt_blocked' && previous[job.url]) { out.status = previous[job.url].status; out.stale = true; out.note = 'YouTube bot-wall; kept previous status'; }
        return out;
      }
    } else if (/twitch\.tv\//i.test(url)) { out.status = 'twitch_page'; return out; }
    const { res, body } = await get(url, job);
    out.http = res.status;
    if (!res.ok) { out.status = `http_${res.status}`; return out; }
    if (res.status === 204 || !body.length) { out.status = 'empty'; return out; }
    const ct = res.headers.get('content-type') ?? '';
    if (isHls(body, ct)) {
      out.kind = out.kind === 'youtube' ? 'youtube-hls' : out.kind === 'rakuten' ? 'rakuten-hls' : out.kind === 'session' ? 'session-hls' : 'hls';
      let text = body.toString(); let base = res.url || job.url;
      if (/#EXT-X-STREAM-INF/.test(text)) {
        out.master = true;
        const lines = text.replace(/\r/g, '').split('\n');
        const i = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
        const variant = lines.slice(i + 1).find(l => l && !l.startsWith('#'));
        const vUrl = variant && resolveUrl(variant.trim(), base);
        if (!vUrl) { out.status = 'bad_manifest'; return out; }
        const v = await get(vUrl, job);
        out.httpVariant = v.res.status;
        if (!v.res.ok) { out.status = `variant_http_${v.res.status}`; return out; }
        text = v.body.toString(); base = v.res.url || vUrl;
      }
      if (!/#EXTINF/.test(text)) { out.status = 'no_segments'; return out; }
      { // FAST stitchers insert ad/slate segments during breaks; only flag when EVERY segment is filler
        const segUrls = text.replace(/\r/g, '').split('\n').filter(l => l && !l.startsWith('#'));
        const filler = segUrls.filter(u => /takedownslate|_slate|adbumper|ad_bumper|blackout|\/ads?\//i.test(u)).length;
        if (segUrls.length && filler === segUrls.length) { out.status = 'slate_only'; return out; }
      }
      const lines = text.replace(/\r/g, '').split('\n');
      const i = lines.findIndex(l => l.startsWith('#EXTINF'));
      const seg = lines.slice(i + 1).find(l => l && !l.startsWith('#'));
      const segUrl = seg && resolveUrl(seg.trim(), base);
      if (!segUrl) { out.status = 'no_segments'; return out; }
      const s = await get(segUrl, job, { maxBytes: 64 * 1024, range: 'bytes=0-65535' });
      out.httpSegment = s.res.status;
      if (!s.res.ok || !s.body?.length) { out.status = `segment_http_${s.res.status}`; return out; }
      out.segmentBytes = s.body.length;
      out.status = 'ok';
    } else if (/dash\+xml/i.test(ct) || body?.subarray(0, 512).toString().includes('<MPD')) {
      out.kind = 'dash'; out.status = 'ok';
    } else if (/video\/|mp2t|octet-stream/i.test(ct) && body?.length > 1024) {
      out.kind = 'progressive'; out.status = 'ok';
    } else if (/text\/html/i.test(ct)) {
      out.kind = 'html'; out.status = 'html_page';
    } else {
      out.kind = ct.slice(0, 40) || 'unknown'; out.status = body?.length ? 'ok_unverified' : 'empty';
    }
    return out;
  } catch (e) {
    out.status = classifyError(e); return out;
  } finally { out.ms = Date.now() - t0; }
}

let done = 0, alive = 0; const t0 = Date.now(); const counts = {};
const logLines = [];
async function worker() {
  while (jobs.length) {
    const job = jobs.pop();
    const r = await checkOne(job);
    results[job.url] = r; done++;
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === 'ok') alive++;
    if (done % 250 === 0 || jobs.length === 0) {
      const line = `${new Date().toISOString().slice(11, 19)} ${done} done, ${alive} ok, ${jobs.length} left, ${((Date.now() - t0) / 1000).toFixed(0)}s`;
      console.log(line); logLines.push(line);
      await writeFile(new URL('check.progress.json', DATA), JSON.stringify({ done, alive, left: jobs.length, counts }));
      await writeFile(new URL('health.json', DATA), JSON.stringify({ ...previous, ...results })); // incremental save
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(new URL('health.json', DATA), JSON.stringify({ ...previous, ...results }));
await writeFile(new URL('check.log', DATA), logLines.join('\n') + '\n');
console.log('\nstatus breakdown:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(`\nwrote data/health.json (${Object.keys(results).length} results) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
