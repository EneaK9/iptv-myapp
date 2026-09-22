// Merges iptv-org API + Free-TV into one channel database: data/channels.json
import { readFile, writeFile } from 'node:fs/promises';
import { parseM3U } from './m3u.mjs';
import { GJIRAFA_MAP } from './gjirafa.mjs';

const RAW = new URL('../data/raw/', import.meta.url);
const OUT = new URL('../data/', import.meta.url);
const json = async n => JSON.parse(await readFile(new URL(`iptv-org.${n}.json`, RAW), 'utf8'));
const text = async n => readFile(new URL(n, RAW), 'utf8');

const [channels, feeds, streams, logos, blocklist] = await Promise.all(
  ['channels', 'feeds', 'streams', 'logos', 'blocklist'].map(json));
const freeTv = parseM3U(await text('free-tv.playlist.m3u8'));

// ---- index iptv-org data ----
const blocked = new Set(blocklist.map(b => b.channel));
const feedsByChannel = new Map();
for (const f of feeds) { (feedsByChannel.get(f.channel) ?? feedsByChannel.set(f.channel, []).get(f.channel)).push(f); }
const logoByChannel = new Map();
for (const l of logos) {
  // prefer main-feed logo, PNG, widest
  const cur = logoByChannel.get(l.channel);
  const score = (l.feed ? 0 : 2) + (l.format === 'PNG' ? 1 : 0) + Math.min(l.width ?? 0, 1000) / 1000;
  if (!cur || score > cur.score) logoByChannel.set(l.channel, { url: l.url, score });
}

const db = new Map(); // id -> channel record
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function ensureChannel(id, base) {
  let c = db.get(id);
  if (!c) {
    c = { id, name: base.name, altNames: base.altNames ?? [], country: base.country ?? null, categories: base.categories ?? [],
          languages: base.languages ?? [], isNsfw: !!base.isNsfw, website: base.website ?? null, logo: base.logo ?? null, streams: [] };
    db.set(id, c);
  }
  return c;
}

for (const ch of channels) {
  if (blocked.has(ch.id)) continue;
  const fs = feedsByChannel.get(ch.id) ?? [];
  const langs = [...new Set(fs.flatMap(f => f.languages ?? []))];
  ensureChannel(ch.id, { name: ch.name, altNames: ch.alt_names, country: ch.country, categories: ch.categories,
    languages: langs, isNsfw: ch.is_nsfw, website: ch.website, logo: logoByChannel.get(ch.id)?.url ?? null });
}

let unmatched = 0;
for (const s of streams) {
  let id = s.channel;
  if (!id) { id = `unmatched:${norm(s.title || s.url)}`; unmatched++; }
  if (blocked.has(id)) continue;
  const c = ensureChannel(id, { name: s.title || id, categories: [] });
  c.streams.push({ url: s.url.trim(), quality: s.quality ?? null, labels: s.labels ?? [], userAgent: s.user_agent ?? null,
    referrer: s.referrer ?? null, feed: s.feed ?? null, source: 'iptv-org' });
}

// ---- Free-TV: join on tvg-id, otherwise create channel ----
let ftMatched = 0, ftNew = 0, ftDupUrl = 0;
const allUrls = new Set([...db.values()].flatMap(c => c.streams.map(s => s.url)));
const urlToStream = new Map([...db.values()].flatMap(c => c.streams.map(s => [s.url, s])));
for (const it of freeTv) {
  const url = it.url.trim();
  const isYt = /youtube\.com|youtu\.be/.test(url);
  const id = it.attrs['tvg-id'] || `free-tv:${norm(it.name)}`;
  if (blocked.has(id)) continue;
  if (allUrls.has(url)) { ftDupUrl++; continue; }
  const existed = db.has(id);
  const c = ensureChannel(id, { name: it.name.replace(/\s*[ⓈⒼⓎⓉ]\s*$/u, ''), country: it.attrs['tvg-country'] ?? null,
    categories: [], logo: it.attrs['tvg-logo'] ?? null });
  c.logo ??= it.attrs['tvg-logo'] ?? null;
  c.country ??= it.attrs['tvg-country'] ?? null;
  c.streams.push({ url, quality: null, labels: isYt ? ['YouTube'] : [], userAgent: it.headers['http-user-agent'] ?? null,
    referrer: it.headers['http-referrer'] ?? null, feed: null, source: 'free-tv', chno: it.attrs['tvg-chno'] ?? null });
  allUrls.add(url);
  existed ? ftMatched++ : ftNew++;
}

// ---- FAST services (Pluto TV / Samsung TV Plus / Roku / Tubi) from BuddyChewChew/app-m3u-generator ----
const FAST = [['plutotv_all', 'fast-pluto'], ['samsungtvplus_all', 'fast-samsung'], ['roku_all', 'fast-roku'], ['tubi_all', 'fast-tubi']];
const fastStats = {};
for (const [file, source] of FAST) {
  let items;
  try { items = parseM3U(await text(`fast.${file}.m3u`)); } catch (e) { if (e.code !== 'ENOENT') throw e; continue; }
  let added = 0, dup = 0;
  for (const it of items) {
    const url = it.url.trim();
    if (allUrls.has(url)) { dup++; continue; }
    const region = (it.attrs['channel-id']?.match(/-([a-z]{2})$/i)?.[1] ?? 'us').toUpperCase();
    const country = region === 'GB' ? 'UK' : region;
    const name = (it.attrs['tvg-name'] || it.name).trim();
    const id = `${source}:${it.attrs['tvg-id'] || norm(name)}`;
    const genre = source === 'fast-tubi' ? (it.attrs['group-title'] ?? '') : '';
    const categories = /sport/i.test(genre) ? ['sports'] : /news/i.test(genre) ? ['news'] : /kids|family/i.test(genre) ? ['kids'] : /movie|film/i.test(genre) ? ['movies'] : /music/i.test(genre) ? ['music'] : [];
    const c = ensureChannel(id, { name, country, categories, logo: it.attrs['tvg-logo'] ?? null });
    c.streams.push({ url, quality: null, labels: ['FAST'], userAgent: null, referrer: null, feed: null, source, chno: it.attrs['tvg-chno'] ?? null });
    allUrls.add(url); added++;
  }
  fastStats[source] = { total: items.length, added, dup };
}

// ---- Gjirafa live channels (official player backend for RTK/T7/KTV/RTV21/ATV/...) ----
let gjAdded = 0;
try {
  const gj = JSON.parse(await readFile(new URL('gjirafa.json', RAW), 'utf8'));
  for (const g of gj) {
    if (!g.handle || /^slow-?tv|^slowtv|radio|glamradio|clubfm|paper-radio|^qendra-e-qytetit/i.test(g.handle) || /SlowTV|Radio/i.test(g.name ?? '')) continue; // TV only
    const m = GJIRAFA_MAP[g.handle] ?? { channel: `gjirafa:${g.handle}`, name: (g.name ?? g.handle).replace(/\s*-\s*Drejtp[eë]rdrejt.*$/i, '').trim(), country: 'XK', categories: [] };
    const c = ensureChannel(m.channel, { name: m.name, country: m.country, categories: m.categories, languages: ['sqi'], logo: g.thumbnail ?? null });
    if (!c.languages.includes('sqi')) c.languages.push('sqi');
    for (const url of g.urls) {
      if (allUrls.has(url)) continue;
      c.streams.unshift({ url, quality: null, labels: ['Official', 'Gjirafa', ...(g.geoBlocked ? ['Geo-blocked'] : [])], userAgent: null, referrer: null, feed: null, source: 'gjirafa', gjirafaHandle: g.handle });
      allUrls.add(url); gjAdded++;
    }
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }

// ---- Rakuten TV (Albania market, free live channels; resolved on play via rakuten://<id>) ----
let rkAdded = 0;
try {
  const rk = JSON.parse(await readFile(new URL('rakuten.json', RAW), 'utf8'));
  for (const r of rk) {
    const url = `rakuten://${r.id}${r.language && r.language !== 'ENG' ? `?lang=${r.language}` : ''}`;
    if (allUrls.has(url)) continue;
    const g = r.genres.join(' ');
    const categories = /sport/i.test(g) ? ['sports'] : /news/i.test(g) ? ['news'] : /kids|children/i.test(g) ? ['kids'] : /music/i.test(g) ? ['music'] : /movie|film|cinema/i.test(g) ? ['movies'] : /document/i.test(g) ? ['documentary'] : [];
    const c = ensureChannel(`rakuten:${r.id}`, { name: r.title, country: null, categories, logo: r.logo });
    c.rakutenGenres = r.genres;
    c.streams.push({ url, quality: null, labels: ['FAST', 'Rakuten TV AL'], userAgent: null, referrer: null, feed: null, source: 'rakuten', chno: r.chno ?? null });
    allUrls.add(url); rkAdded++;
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }

// ---- local DVB-T2 tuner (antenna reception on the LAN) ----
let tunerAdded = 0;
try {
  const tuner = JSON.parse(await readFile(new URL('tuner.json', RAW), 'utf8'));
  for (const t of tuner) {
    if (!t.url || allUrls.has(t.url)) continue;
    const id = t.channel ?? `tuner:${norm(t.name)}`;
    const c = ensureChannel(id, { name: t.name, country: t.country ?? 'AL', categories: [], languages: ['sqi'], logo: t.logo ?? null });
    if (!c.languages.includes('sqi')) c.languages.push('sqi');
    c.streams.unshift({ url: t.url, quality: null, labels: ['Local', 'DVB-T2', ...(t.encrypted ? ['Encrypted'] : [])], userAgent: null, referrer: null, feed: null, source: 'local-tuner', chno: t.number ?? null });
    allUrls.add(t.url); tunerAdded++;
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }

// ---- curated official sources: sources/official-youtube.json (YouTube lives) and sources/official-hls.json (open broadcaster HLS/DASH) ----
let officialAdded = 0;
for (const [file, source, labels] of [['official-youtube.json', 'official-youtube', ['YouTube', 'Official']], ['official-hls.json', 'official-hls', ['Official']], ['official-dynamic.json', 'official-session', ['Official', 'Session']]]) {
  let official;
  try { official = JSON.parse(await readFile(new URL(`../sources/${file}`, import.meta.url), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; continue; }
  for (const o of official) {
    if (allUrls.has(o.url)) { const ex = urlToStream.get(o.url); if (ex) { for (const l of labels) if (!ex.labels.includes(l)) ex.labels.push(l); ex.official = true; ex.note ??= o.note ?? null; } continue; }
    // hand-verified official sources are exempt from the iptv-org blocklist (which reflects notices sent to GitHub, not the broadcaster's own feed)
    const c = ensureChannel(o.channel, { name: o.name, country: o.country, categories: o.categories, languages: o.languages, logo: o.logo ?? null });
    c.languages = [...new Set([...(c.languages ?? []), ...(o.languages ?? [])])];
    for (const cat of o.categories ?? []) if (!c.categories.includes(cat)) c.categories.push(cat);
    c.streams.unshift({ url: o.url, quality: o.quality ?? null, labels: [...labels, ...(o.labels ?? [])], userAgent: o.userAgent ?? null, referrer: o.referrer ?? null, feed: null, source, note: o.note ?? null });
    allUrls.add(o.url); officialAdded++;
  }
}

// ---- heuristic category fill: many iptv-org channels have no category; tag obvious sports channels by name ----
const SPORTS_RE = /\b(scooore|sportdigital|solocalcio|sportface|golazo|talksport|sport|sports|deporte|deportes|esporte|esportes|futbol|fútbol|football|soccer|calcio|fussball|fußball|voetbal|piłka|liga|arena|kick|goal|golazo|match|premier|champions|bein|espn|dazn|eurosport|supersport|setanta|tsn|sportsnet|sky sport|sportklub|polsat sport|nbc sports|cbs sports|fox sports|fanduel|bally|stadium|fite|motorsport|motogp|nascar|nba|nfl|mlb|nhl|ufc|wwe|aew|tennis|golf|racing|f1|formula|wrestl|boxing|boxeo|box tv|cricket|rugby|hockey|basket|volley|fight|mma|olymp|marathon|fishing|hunting|equestr|equidia|turf|hipica|hippique|ski|surf|extreme)\b/i;
const NOT_SPORTS_RE = /\b(music box|box kids|music|kids|cine|movie|film|news 24|24 news)\b/i;
let sportsTagged = 0;
for (const c of db.values()) {
  if (!c.categories.includes('sports') && SPORTS_RE.test(c.name) && !NOT_SPORTS_RE.test(c.name)) { c.categories.push('sports'); c.sportsByName = true; sportsTagged++; }
}

// ---- output ----
// stream priority: antenna first, then the broadcaster's own feeds, then aggregators
const SOURCE_PRIORITY = ['local-tuner', 'official-hls', 'official-session', 'gjirafa', 'official-youtube', 'iptv-org', 'free-tv', 'rakuten', 'fast-samsung', 'fast-tubi', 'fast-roku', 'fast-pluto'];
const prio = s => { if (s.official && !/youtube/.test(s.source)) return SOURCE_PRIORITY.indexOf('official-hls'); const i = SOURCE_PRIORITY.indexOf(s.source); return i === -1 ? SOURCE_PRIORITY.length : i; };
for (const c of db.values()) c.streams.sort((a, b) => prio(a) - prio(b));
const list = [...db.values()].filter(c => c.streams.length > 0).sort((a, b) => a.name.localeCompare(b.name));
await writeFile(new URL('channels.json', OUT), JSON.stringify(list));
const totalStreams = list.reduce((n, c) => n + c.streams.length, 0);
const sq = list.filter(c => c.country === 'AL' || c.country === 'XK' || c.languages.includes('sqi'));
console.log(`channels with streams: ${list.length}   total streams: ${totalStreams}`);
console.log(`  iptv-org streams: ${streams.length} (${unmatched} unmatched to a channel)`);
console.log(`  free-tv entries: ${freeTv.length} -> ${ftMatched} joined existing channel, ${ftNew} new channels, ${ftDupUrl} duplicate URLs skipped`);
console.log(`  Albanian (AL/XK/sqi): ${sq.length} channels, ${sq.reduce((n, c) => n + c.streams.length, 0)} streams`);
console.log(`  official YouTube sources added: ${officialAdded}`);
console.log(`  sports tagged by name (no category upstream): ${sportsTagged}`);
console.log(`  FAST: ${Object.entries(fastStats).map(([k, v]) => `${k} ${v.added} new (${v.dup} already known) of ${v.total}`).join('; ')}`);
console.log(`  gjirafa streams added: ${gjAdded}`);
console.log(`  rakuten channels added: ${rkAdded}`);
console.log(`  local tuner channels: ${tunerAdded}`);
console.log(`  nsfw channels: ${list.filter(c => c.isNsfw).length}`);
console.log(`wrote data/channels.json (${(Buffer.byteLength(JSON.stringify(list)) / 1e6).toFixed(1)} MB)`);
