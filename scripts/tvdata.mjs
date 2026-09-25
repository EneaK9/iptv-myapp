// Builds data/tv.json: the compact channel list the TV apps download from GitHub (raw.githubusercontent.com allows it).
// Only what a TV can use: channels that work or worked in the last 48 h (Albanian ones always), streams in the order
// to try them, and short field names so a 2018 TV parses it quickly.
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeStatus } from './status.mjs';

const DATA = new URL('../data/', import.meta.url);
const RECENT_MS = 48 * 3600 * 1000;
const channels = JSON.parse(await readFile(new URL('channels.json', DATA), 'utf8'));
let health = {};
try { health = JSON.parse(await readFile(new URL('health.json', DATA), 'utf8')); } catch {}

const UNPLAYABLE = /^(rtmp|rtsp|srt|mms|mmsh|udp|rtp):|twitch\.tv\//i; // no TV player takes these; twitch pages need twitch://
const isAlbanian = c => c.country === 'AL' || c.country === 'XK' || (c.languages ?? []).includes('sqi');
const rank = { ok: 0, recent: 1, unknown: 2, down: 3 };

const out = [];
for (const c of channels) {
  if (c.isNsfw) continue;
  const streams = c.streams.filter(s => !UNPLAYABLE.test(s.url)).map(s => {
    const h = health[s.url], status = h ? normalizeStatus(h.status) : null;
    const lastOk = h?.lastOk ?? (status === 'ok' ? h.checkedAt : null);
    const state = status === 'ok' ? 'ok' : lastOk && Date.now() - Date.parse(lastOk) < RECENT_MS ? 'recent' : status ? 'down' : 'unknown';
    const st = { u: s.url, h: rank[state] };
    if (s.userAgent) st.ua = s.userAgent;
    if (s.referrer) st.r = s.referrer;
    if (s.labels?.includes('Radio')) st.a = 1; // audio only
    return st;
  }).sort((a, b) => a.h - b.h);
  if (!streams.length) continue;
  const best = streams[0].h;
  if (best > rank.recent && !isAlbanian(c)) continue;
  const ch = { i: c.id, n: c.name, h: best, s: streams };
  if (c.country) ch.c = c.country;
  if (c.categories?.length) ch.g = c.categories;
  if (c.logo) ch.l = c.logo;
  if (isAlbanian(c)) ch.sq = 1;
  out.push(ch);
}
out.sort((a, b) => a.h - b.h || a.n.localeCompare(b.n));
// country names for the Countries menu (the TVs' Chromium 56 has no Intl.DisplayNames)
const countries = {};
try {
  const names = new Map(JSON.parse(await readFile(new URL('raw/iptv-org.countries.json', DATA), 'utf8')).map(c => [c.code, c.name]));
  for (const ch of out) if (ch.c) countries[ch.c] = names.get(ch.c) ?? ch.c;
} catch {}
const body = JSON.stringify({ v: 1, generated: new Date().toISOString(), countries, channels: out });
await writeFile(new URL('tv.json', DATA), body);
console.log(`wrote data/tv.json: ${out.length} channels (${out.filter(c => c.sq).length} Albanian), ${(body.length / 1e6).toFixed(2)} MB`);
