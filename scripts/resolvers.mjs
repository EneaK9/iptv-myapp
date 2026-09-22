// Resolve-on-play for broadcasters whose OWN public web player hands out a short-lived stream URL/session.
// Each resolver replicates exactly what the broadcaster's page does (no auth bypass) and returns
// { hls, headers, expiresAt }. `headers` (cookie/referer) must be sent with every request of that stream.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const cache = new Map();

const RESOLVERS = {
  // Report TV: report-tv.al/report_live embeds deb20stream.duckdns.org/playerhls10.html which calls /playurl?ttl=1800 -> signed URL (30 min)
  async reporttv() {
    const base = 'https://deb20stream.duckdns.org';
    const res = await fetch(`${base}/playurl?ttl=1800`, { headers: { 'user-agent': UA, referer: `${base}/playerhls10.html`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw Object.assign(new Error(`playurl HTTP ${res.status}`), { code: 'resolver_error' });
    const d = await res.json();
    if (!d.url) throw Object.assign(new Error('playurl: no url'), { code: 'resolver_error' });
    return { hls: new URL(d.url, base).href, headers: { referer: `${base}/playerhls10.html` }, expiresAt: Date.now() + 25 * 60 * 1000 };
  },
  // MCN TV: mcntv.al/articles/live calls GET /api/stream-session -> 3 HttpOnly cookies (Path=/hls/, 180 s) -> /hls/mcntv.m3u8 (AES-128, key on same path)
  async mcntv() {
    const res = await fetch('https://mcntv.al/api/stream-session', { headers: { 'user-agent': UA, referer: 'https://mcntv.al/articles/live', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw Object.assign(new Error(`stream-session HTTP ${res.status}`), { code: 'resolver_error' });
    const cookies = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
    if (!cookies) throw Object.assign(new Error('stream-session: no cookies'), { code: 'resolver_error' });
    const d = await res.json().catch(() => ({}));
    const ttl = Number(d.ttl ?? 180) * 1000;
    return { hls: 'https://mcntv.al/hls/mcntv.m3u8', headers: { cookie: cookies, referer: 'https://mcntv.al/articles/live' }, expiresAt: Date.now() + Math.max(ttl - 30_000, 30_000) };
  },
};

export const isResolver = u => /^(reporttv|mcntv):\/\//.test(u);
export const resolverName = u => u.split('://')[0];

export async function resolveDynamic(url) {
  const name = resolverName(url);
  const fn = RESOLVERS[name];
  if (!fn) throw Object.assign(new Error(`no resolver for ${name}`), { code: 'resolver_unknown' });
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const out = await fn();
  cache.set(name, out);
  return out;
}
