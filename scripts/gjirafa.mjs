// Gjirafa Video (video.gjirafa.com) public live-channel API — the official player backend for RTK, T7, KTV, RTV21, ATV, etc.
// Returns open HLS. IDs/paths rotate, so this is fetched at pipeline time (and can be re-resolved by the app).
const API = 'https://edge.video.gjirafa.com/client/v1';
const H = { 'user-agent': 'Mozilla/5.0', accept: 'application/json', origin: 'https://video.gjirafa.com', referer: 'https://video.gjirafa.com/' };

// map Gjirafa channel handles -> our channel ids / metadata
export const GJIRAFA_MAP = {
  'rtk3': { channel: 'RTK3.xk', name: 'RTK 3', country: 'XK', categories: ['general'] },
  'rtk-1-sat': { channel: 'RTK1Sat.xk', name: 'RTK 1 Sat', country: 'XK', categories: ['general'] },
  'rtk1': { channel: 'RTK1.xk', name: 'RTK 1', country: 'XK', categories: ['general'] },
  'rtk2': { channel: 'RTK2.xk', name: 'RTK 2', country: 'XK', categories: ['general'] },
  'rtk4': { channel: 'RTK4.xk', name: 'RTK 4', country: 'XK', categories: ['general'] },
  'ktv-live': { channel: 'Kohavision.xk', name: 'Kohavision', country: 'XK', categories: ['general'] },
  'arta-news': { channel: 'TVArta.xk', name: 'TV Arta', country: 'XK', categories: ['news'] },
  't7-live': { channel: 'T7.xk', name: 'T7', country: 'XK', categories: ['general'] },
  'rtv-21-live': { channel: 'RTV21.xk', name: 'RTV21', country: 'XK', categories: ['general'] },
  'atv-live-tv': { channel: 'ATV.xk', name: 'ATV', country: 'XK', categories: ['general'] },
  'syrivision': { channel: 'TVSyri.xk', name: 'TV Syri', country: 'XK', categories: ['general'] },
  'euronews-albania-live': { channel: 'EuronewsAlbania.al', name: 'Euronews Albania', country: 'AL', categories: ['news'] },
  'rtv-besa-live-2': { channel: 'RTVBesa.xk', name: 'RTV Besa', country: 'XK', categories: ['general'] },
  'tv-prizreni-live': { channel: 'TVPrizreni.xk', name: 'TV Prizreni', country: 'XK', categories: ['general'] },
  'tv-news-live': { channel: 'TVNews.xk', name: 'TV News', country: 'XK', categories: ['news'] },
  'zico-tv-live': { channel: 'ZICOTV.rs', name: 'ZICO TV', country: 'RS', categories: ['music'] },
  'pro1-tv-2': { channel: 'PRO1.xk', name: 'PRO1', country: 'XK', categories: ['general'] },
};

async function get(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export async function fetchGjirafaLive() {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const d = await get(`${API}/videos/live?page=${page}&pageSize=15`);
    const list = d?.result?.items ?? d?.items ?? d?.result ?? d?.data ?? [];
    if (!Array.isArray(list) || list.length === 0) break;
    items.push(...list);
    if (list.length < 15) break;
  }
  const out = [];
  for (const it of items) {
    const handle = it.handle ?? it.channel?.handle;
    if (it.isPremium || it.payToViewConfig?.isLocked) continue;
    let detail;
    try { detail = await get(`${API}/videos/${it.id}`); } catch { continue; }
    const r = detail?.result ?? detail;
    const urls = (r?.playerConfig?.playbackUrls ?? []).map(p => p.file ?? p.url).filter(u => u && /\.m3u8/i.test(u));
    if (!urls.length) continue;
    out.push({ id: it.id, handle, name: it.name ?? r?.name, channelHandle: it.channel?.handle ?? r?.channel?.handle, urls,
      geoBlocked: !!r?.geoBlockConfig?.isGeoBlocked, hasDRM: !!r?.playerConfig?.hasDRM, thumbnail: r?.thumbnailUrl ?? it.thumbnailUrl ?? null });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = await fetchGjirafaLive();
  console.log(JSON.stringify(list, null, 1));
}
