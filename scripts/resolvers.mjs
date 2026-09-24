// Resolve-on-play for broadcasters whose OWN public web player hands out a short-lived stream URL/session.
// Each resolver replicates exactly what the broadcaster's page does (no auth bypass) and returns
// { hls, headers, expiresAt }. `headers` (cookie/referer) must be sent with every request of that stream.
// URL form: <scheme>://<arg>, e.g. reporttv://live, mrt://mrt2-sat
import { plexToken, plexStreamUrl } from './plex.mjs';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const cache = new Map();
const fail = msg => Object.assign(new Error(msg), { code: 'resolver_error' });

const RESOLVERS = {
  // Report TV: report-tv.al/report_live embeds deb20stream.duckdns.org/playerhls10.html which calls /playurl -> signed playlist.
  // Signatures expire at the next :00/:30 boundary + (ttl - 1800) s, so ttl=1800 can die within seconds; 3600 gives >= 30 min.
  async reporttv() {
    const base = 'https://deb20stream.duckdns.org';
    const res = await fetch(`${base}/playurl?ttl=3600`, { headers: { 'user-agent': UA, referer: `${base}/playerhls10.html`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`playurl HTTP ${res.status}`);
    const d = await res.json();
    if (!d.url) throw fail('playurl: no url');
    return { hls: new URL(d.url, base).href, headers: { referer: `${base}/playerhls10.html` }, expiresAt: Date.now() + 25 * 60 * 1000 };
  },
  // MCN TV: mcntv.al/articles/live calls GET /api/stream-session -> 3 HttpOnly cookies (Path=/hls/, 180 s) -> /hls/mcntv.m3u8 (AES-128, key on same path)
  async mcntv() {
    const res = await fetch('https://mcntv.al/api/stream-session', { headers: { 'user-agent': UA, referer: 'https://mcntv.al/articles/live', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`stream-session HTTP ${res.status}`);
    const cookies = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
    if (!cookies) throw fail('stream-session: no cookies');
    const d = await res.json().catch(() => ({}));
    const ttl = Number(d.ttl ?? 180) * 1000;
    return { hls: 'https://mcntv.al/hls/mcntv.m3u8', headers: { cookie: cookies, referer: 'https://mcntv.al/articles/live' }, expiresAt: Date.now() + Math.max(ttl - 30_000, 30_000) };
  },
  // Klan Kosova: klankosova.tv's TvLivePlayer calls GET /api/stream/token every 240 s -> { url: https://stream.klankosova.tv/live.m3u8?t=... }.
  // Tokens die after ~5-9 min, so refreshUrl() re-signs every later request of a playing stream.
  async klankosova() {
    const res = await fetch('https://klankosova.tv/api/stream/token', { headers: { 'user-agent': UA, referer: 'https://klankosova.tv/', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`stream/token HTTP ${res.status}`);
    const d = await res.json();
    if (!d.url) throw fail('stream/token: no url');
    return { hls: d.url, headers: {}, expiresAt: Date.now() + 200_000 };
  },
  // MRT (North Macedonia public TV): play.mrt.com.mk/live/<slug> embeds the Nimble URL with a 30-min wmsAuthSign in `gxArCurrPlaylist`.
  // Slugs: mrt1 mrt2 mrt3 mrt4 mrt5 sobraniski mrt1-sat mrt2-sat; only the -sat feeds and sobraniski play outside North Macedonia.
  async mrt(slug) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw fail(`bad MRT slug ${slug}`);
    const res = await fetch(`https://play.mrt.com.mk/live/${slug}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`play.mrt.com.mk HTTP ${res.status}`);
    const m = (await res.text()).replace(/\\\//g, '/').match(/https:\/\/vod-c57\.interspace\.com:443\/channel_abr\/\d+\/playlist\.m3u8\?wmsAuthSign=[^"'\s]+/);
    if (!m) throw fail('no wmsAuthSign URL in page');
    return { hls: m[0], headers: {}, expiresAt: Date.now() + 25 * 60 * 1000 };
  },
  // MTVA (Hungarian public media): mediaklikk.hu's player iframe carries playData[0].file, a CDN URL bound to the viewer's IP.
  // Ids: mtv4live (M4 Sport), mtv4plus (M4 Sport+).
  async mediaklikk(id) {
    if (!/^[a-z0-9]+$/.test(id)) throw fail(`bad mediaklikk id ${id}`);
    const res = await fetch(`https://player.mediaklikk.hu/playernew/player.php?video=${id}&noflash=yes`, { headers: { 'user-agent': UA, referer: 'https://mediaklikk.hu/' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`mediaklikk player HTTP ${res.status}`);
    const m = (await res.text()).match(/"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
    if (!m) throw fail('mediaklikk: no playData file');
    const hls = m[1].replace(/\\\//g, '/');
    return { hls: hls.startsWith('//') ? `https:${hls}` : hls, headers: { referer: 'https://mediaklikk.hu/' }, expiresAt: Date.now() + 20 * 60 * 1000 };
  },
  // RTV Slovenija: 365.rtvslo.si asks api.rtvslo.si for the live stream -> streamer + file with a 1-hour hdnts token. Ids: tv.slo1, tv.slo2, tv.slo3.
  async rtvslo(id) {
    if (!/^[a-z0-9.]+$/.test(id)) throw fail(`bad rtvslo id ${id}`);
    const res = await fetch(`https://api.rtvslo.si/ava/getLiveStream/${id}?client_id=82013fb3a531d5414f478747c1aca622`, { headers: { 'user-agent': UA, referer: 'https://365.rtvslo.si/' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`rtvslo HTTP ${res.status}`);
    const f = (await res.json()).response?.mediaFiles?.find(x => x.type === 'hls');
    if (!f) throw fail('rtvslo: no hls mediaFile');
    return { hls: f.streamer + f.file, headers: {}, expiresAt: Date.now() + 50 * 60 * 1000 };
  },
  // Dailymotion lives (e.g. Sport en France's official channel): the embed player's metadata JSON lists a signed auto-quality HLS URL.
  async dailymotion(id) {
    if (!/^[a-z0-9]+$/i.test(id)) throw fail(`bad dailymotion id ${id}`);
    const res = await fetch(`https://geo.dailymotion.com/video/${id}.json?legacy=true`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`dailymotion HTTP ${res.status}`);
    const d = await res.json();
    const hls = d.qualities?.auto?.[0]?.url;
    if (!hls) throw fail(`dailymotion: ${d.error?.title ?? 'no hls'}`);
    return { hls, headers: {}, expiresAt: Date.now() + 30 * 60 * 1000 };
  },
  // CRTV (Cameroon public TV): crtv.cm/live/<channel> asks its ACAN OTT backend for a 10-min wmsAuthSign URL. Ids: 50006 (CRTV Sport).
  async crtv(id) {
    if (!/^\d+$/.test(id)) throw fail(`bad crtv id ${id}`);
    const res = await fetch(`https://tveapi.acan.group/myapiv2/directplayback/${id}/json`, { headers: { 'user-agent': UA, referer: 'https://www.crtv.cm/' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`acan HTTP ${res.status}`);
    const d = await res.json();
    const hls = d.web_url ?? d.direct_url;
    if (!hls) throw fail('acan: no url');
    return { hls, headers: {}, expiresAt: Date.now() + 8 * 60 * 1000 };
  },
  // UTRK/KTRK (Kyrgyz public TV): utrk.kg/live/tv?channel=<n> inlines a 3-hour mediabay token. Ids: 51 (KTRK Sport).
  async utrk(id) {
    if (!/^\d+$/.test(id)) throw fail(`bad utrk id ${id}`);
    const res = await fetch(`https://utrk.kg/live/tv?channel=${id}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`utrk.kg HTTP ${res.status}`);
    const m = (await res.text()).match(/https:\/\/st\d*\.mediabay\.tv\/[^'"\s]+\/index\.m3u8\?token=[^'"\s]+/);
    if (!m) throw fail('utrk: no mediabay URL in page');
    return { hls: m[0], headers: {}, expiresAt: Date.now() + 150 * 60 * 1000 };
  },
  // Plex free Live TV: anonymous web-client token (scripts/plex.mjs); arg is the channel's gridKey.
  async plex(gridKey) {
    if (!/^[a-f0-9]+$/.test(gridKey)) throw fail(`bad plex gridKey ${gridKey}`);
    return { hls: plexStreamUrl(gridKey, await plexToken()), headers: {}, expiresAt: Date.now() + 6 * 3600 * 1000 };
  },
};

export const isResolver = u => /^(reporttv|mcntv|klankosova|mrt|mediaklikk|rtvslo|dailymotion|crtv|utrk|plex):\/\//.test(u);
export const resolverName = u => u.split('://')[0];

export async function resolveDynamic(url) {
  const [name, arg = ''] = url.split('://');
  const fn = RESOLVERS[name];
  if (!fn) throw Object.assign(new Error(`no resolver for ${name}`), { code: 'resolver_unknown' });
  const hit = cache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const out = await fn(arg);
  cache.set(url, out);
  return out;
}

// Streams whose token is carried on every variant/segment URL: swap in the current token before each upstream request.
export async function refreshUrl(target) {
  let u;
  try { u = new URL(target); } catch { return target; }
  if (u.hostname === 'stream.klankosova.tv' && u.searchParams.has('t')) {
    const fresh = new URL((await resolveDynamic('klankosova://live')).hls).searchParams.get('t');
    if (fresh) { u.searchParams.set('t', fresh); return u.href; }
  }
  return target;
}
