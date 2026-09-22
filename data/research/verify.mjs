// Segment-level verification of research candidates: node data/research/verify.mjs [candidates.json]
// For each entry: resolve (if `resolve` is set) -> master playlist -> first variant -> first media segment.
// Prints one line per entry and writes <file>.results.json next to the input.
import { readFile, writeFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const file = process.argv[2] ?? new URL('candidates.json', import.meta.url).pathname;
const list = JSON.parse(await readFile(file, 'utf8'));

async function get(url, h = {}, maxBytes = 256 * 1024) {
  const headers = { 'user-agent': h.userAgent || UA, accept: '*/*' };
  if (h.referrer) { headers.referer = h.referrer; headers.origin = new URL(h.referrer).origin; }
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  const chunks = []; let n = 0;
  if (res.body) {
    const reader = res.body.getReader();
    while (n < maxBytes) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    reader.cancel().catch(() => {});
  }
  return { res, body: Buffer.concat(chunks) };
}

// token recipes taken from each broadcaster's own public player
const RESOLVE = {
  async klankosova() {
    const d = await (await fetch('https://klankosova.tv/api/stream/token', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })).json();
    return d.url;
  },
  async reporttv() {
    const base = 'https://deb20stream.duckdns.org';
    const d = await (await fetch(`${base}/playurl?ttl=3600`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })).json();
    return new URL(d.url, base).href;
  },
  async mrt(slug) {
    const html = await (await fetch(`https://play.mrt.com.mk/live/${slug}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })).text();
    const m = html.replace(/\\\//g, '/').match(/https:\/\/vod-c57\.interspace\.com:443\/channel_abr\/\d+\/playlist\.m3u8\?wmsAuthSign=[^"'\s]+/);
    if (!m) throw new Error('no wmsAuthSign URL in page');
    return m[0];
  },
};

const firstUri = text => text.replace(/\r/g, '').split('\n').find(l => l && !l.startsWith('#'))?.trim();

async function verify(c) {
  const r = { channel: c.channel, name: c.name, status: 'unknown' };
  try {
    let url = c.url;
    if (c.resolve) { const [kind, arg] = c.resolve.split(':'); url = await RESOLVE[kind](arg); r.resolved = true; }
    let { res, body } = await get(url, c);
    r.master = res.status;
    if (!res.ok) return { ...r, status: `playlist_http_${res.status}` };
    let text = body.toString(); let base = res.url || url;
    if (!text.includes('#EXTM3U')) return { ...r, status: 'not_hls' };
    if (text.includes('#EXT-X-STREAM-INF')) {
      const v = new URL(firstUri(text.slice(text.indexOf('#EXT-X-STREAM-INF'))), base).href;
      ({ res, body } = await get(v, c));
      r.variant = res.status;
      if (!res.ok) return { ...r, status: `variant_http_${res.status}` };
      text = body.toString(); base = res.url || v;
    }
    const segLine = firstUri(text.slice(Math.max(0, text.indexOf('#EXTINF'))));
    if (!segLine) return { ...r, status: 'no_segments' };
    const s = await get(new URL(segLine, base).href, c, 64 * 1024);
    r.segment = s.res.status; r.bytes = s.body.length;
    r.status = s.res.ok && s.body.length ? 'ok' : `segment_http_${s.res.status}`;
    return r;
  } catch (e) { return { ...r, status: 'error', error: e.message }; }
}

const results = [];
for (let i = 0; i < list.length; i += 6) results.push(...await Promise.all(list.slice(i, i + 6).map(verify)));
for (const r of results) console.log(`${r.status === 'ok' ? 'OK  ' : 'FAIL'} ${(r.name ?? r.channel).padEnd(26)} ${r.status.padEnd(20)} ${r.bytes ? `${r.bytes} B` : r.error ?? ''}`);
console.log(`\n${results.filter(r => r.status === 'ok').length} of ${results.length} working`);
await writeFile(file.replace(/\.json$/, '.results.json'), JSON.stringify(results, null, 1));
