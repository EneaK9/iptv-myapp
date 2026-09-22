// Resolves an official YouTube live page (channel /live, watch?v=, youtu.be) to a playable HLS manifest URL.
// Route 1: find the live videoId on the page, then ask YouTube's player API as the Android client, whose HLS
//          manifests deliver segments without extra tokens. Route 2 (fallback): hlsManifestUrl embedded in the
//          mobile-Safari page. Results are cached; Google manifests expire ~6h after issue.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = { name: 'ANDROID', version: '20.10.38', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', headerId: '3' };
const cache = new Map(); // normalized page url -> result
const channelIds = new Map(); // normalized /live page url -> UC... channel id (wall-proof RSS discovery)
export function registerChannelIds(entries) { for (const e of entries) if (e.channelId && e.url) channelIds.set(normalizeYouTube(e.url), e.channelId); }

// RSS is not affected by YouTube's bot wall: returns recent videos, newest first, LIVE-titled first
async function rssCandidates(channelId, timeoutMs) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'user-agent': DESKTOP_UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<title>([^<]*)<\/title>[\s\S]*?<published>([^<]+)<\/published>[\s\S]*?<\/entry>/g)]
    .map(m => ({ videoId: m[1], title: m[2], published: Date.parse(m[3]) }));
  const dayAgo = Date.now() - 36 * 3600 * 1000;
  return items.filter(i => i.published > dayAgo).sort((a, b) => (/live/i.test(b.title) - /live/i.test(a.title)) || (b.published - a.published)).slice(0, 4);
}
const TTL_MS = 90 * 60 * 1000;

export const isYouTube = u => /^(https?:)?\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(u);

export function normalizeYouTube(u) {
  const url = new URL(u);
  if (url.hostname.endsWith('youtu.be')) return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
  url.hostname = 'www.youtube.com'; url.protocol = 'https:';
  if (url.pathname.startsWith('/embed/')) return `https://www.youtube.com/watch?v=${url.pathname.split('/')[2]}`;
  return url.href;
}

const err = (code, msg) => Object.assign(new Error(msg), { code });
const unesc = s => s.replace(/\\\//g, '/').replace(/\\u0026/g, '&');

async function fetchPage(pageUrl, ua, timeoutMs) {
  const res = await fetch(pageUrl, { headers: { 'user-agent': ua, cookie: 'CONSENT=YES+; SOCS=CAI', 'accept-language': 'en' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw err('yt_page_' + res.status, `youtube page HTTP ${res.status}`);
  return res.text();
}

function pageInfo(html) {
  // YouTube serves a "confirm you're not a bot" shell after heavy automated access: player data missing, LOGIN_REQUIRED present
  const botWalled = /"status":"LOGIN_REQUIRED"/.test(html) && /not a bot|Sign in to confirm/i.test(html);
  const videoId = html.match(/"videoDetails":\{"videoId":"([^"]+)"/)?.[1] ?? null;
  const title = html.match(/"videoDetails":\{"videoId":"[^"]+","title":"([^"]*)"/)?.[1] ?? null;
  const liveNow = /"isLiveNow":true/.test(html);
  const hls = html.match(/"hlsManifestUrl":"([^"]+)"/)?.[1] ?? null;
  const channelId = html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ?? html.match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1] ?? null;
  return { videoId, title: title && unesc(title), liveNow, hls: hls && unesc(hls), botWalled, channelId };
}

async function playerApi(videoId, timeoutMs) {
  const body = { videoId, contentCheckOk: true, racyCheckOk: true,
    context: { client: { clientName: ANDROID.name, clientVersion: ANDROID.version, androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en', gl: 'US' } } };
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', 'user-agent': ANDROID.ua, 'x-youtube-client-name': ANDROID.headerId, 'x-youtube-client-version': ANDROID.version, origin: 'https://www.youtube.com' },
    body: JSON.stringify(body) });
  if (!res.ok) throw err('yt_api_' + res.status, `player api HTTP ${res.status}`);
  const p = await res.json();
  const status = p.playabilityStatus?.status;
  if (status && status !== 'OK') throw err('yt_' + status.toLowerCase(), p.playabilityStatus?.reason || status);
  return { hls: p.streamingData?.hlsManifestUrl ?? null, title: p.videoDetails?.title ?? null, isLive: !!p.videoDetails?.isLive };
}

export async function resolveYouTubeLive(pageUrl, { timeoutMs = 15000 } = {}) {
  const key = normalizeYouTube(pageUrl);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit;

  // 1) page -> videoId (+ fallback manifest)
  let info = pageInfo(await fetchPage(key, DESKTOP_UA, timeoutMs));
  let hls = null, title = info.title, route = 'android-api', videoId = info.videoId;

  if (info.botWalled && !info.liveNow) {
    // page is walled: discover candidates via RSS (needs a known channelId), then ask the player API which one is live
    const cid = channelIds.get(key);
    if (!cid) throw err('yt_blocked', 'YouTube is serving a bot-check page to this IP; retry later');
    let apiWalled = false;
    for (const cand of await rssCandidates(cid, timeoutMs)) {
      try { const p = await playerApi(cand.videoId, timeoutMs); if (p.isLive && p.hls) { hls = p.hls; title = p.title ?? cand.title; videoId = cand.videoId; route = 'rss+android-api'; break; } }
      catch (e) { if (e.code === 'yt_login_required') { apiWalled = true; break; } }
    }
    if (!hls) throw err(apiWalled ? 'yt_blocked' : 'yt_offline', apiWalled ? 'YouTube bot-check on page and API; retry later' : 'no live video found via RSS');
  } else {
    if (!info.videoId) throw err('yt_offline', 'channel is not live right now');
    if (!info.liveNow && !info.hls) throw err('yt_offline', 'channel is not live right now');
    // 2) Android player API
    try { const p = await playerApi(info.videoId, timeoutMs); hls = p.hls; title = p.title ?? title; } catch (e) { /* fall through to page manifest */ }
  }
  // 3) fallback: mobile-Safari page manifest
  if (!hls && videoId) { const m = pageInfo(await fetchPage(`https://www.youtube.com/watch?v=${videoId}`, IOS_UA, timeoutMs)); hls = m.hls; route = 'ios-page'; }
  if (!hls) throw err('yt_no_hls', 'live but no HLS manifest available');

  const expire = Number(hls.match(/\/expire\/(\d+)/)?.[1] ?? 0) * 1000;
  const out = { hls, title, videoId, route, expiresAt: Math.min(expire ? expire - 10 * 60 * 1000 : Infinity, Date.now() + TTL_MS) };
  cache.set(key, out);
  return out;
}
