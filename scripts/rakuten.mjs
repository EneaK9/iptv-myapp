// Rakuten TV free live channels — Albania is a native market (market_code=al, classification_id=270).
// Channel list is fetched at pipeline time; stream URLs are short-lived and resolved on demand (rakuten://<id> pseudo-URLs).
const BASE = 'https://gizmo.rakuten.tv/v3';
const Q = 'classification_id=270&market_code=al&device_identifier=web&locale=en&device_serial=not_implemented';
const H = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', accept: 'application/json', origin: 'https://www.rakuten.tv', referer: 'https://www.rakuten.tv/al' };
const cache = new Map(); // id -> { hls, expiresAt }
const TTL_MS = 30 * 60 * 1000;

export const isRakuten = u => /^rakuten:\/\//.test(u);
export const rakutenId = u => u.replace(/^rakuten:\/\//, '').split('?')[0];
export const rakutenLang = u => new URLSearchParams(u.split('?')[1] ?? '').get('lang') || 'ENG';

export async function fetchRakutenChannels({ timeoutMs = 20000 } = {}) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${BASE}/live_channels?${Q}&page=${page}&per_page=50`, { headers: H, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`rakuten list HTTP ${res.status}`);
    const d = await res.json();
    const items = d.data ?? [];
    for (const it of items) {
      const genres = (it.labels?.tags ?? it.genres ?? []).map(g => g.name ?? g).filter(Boolean);
      const language = it.labels?.languages?.[0]?.id ?? 'ENG';
      const img = it.images ?? {};
      out.push({ id: it.id, title: it.title, genres, language, chno: it.channel_number ?? null, logo: img.artwork ?? img.snapshot ?? img.logo ?? null, numerical_id: it.numerical_id ?? null });
    }
    const total = d.meta?.pagination?.count ?? null;
    if (items.length < 50 || (total && out.length >= total)) break;
  }
  return out;
}

export async function resolveRakuten(id, { timeoutMs = 20000, lang = 'ENG' } = {}) {
  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const body = { content_id: id, content_type: 'live_channels', market_code: 'al', classification_id: 270, device_identifier: 'web', device_serial: 'not_implemented',
    device_stream_video_quality: 'FHD', audio_quality: '2.0', player: 'web:HLS-NONE', audio_language: lang, video_type: 'stream', subtitle_language: 'MIS' };
  const res = await fetch(`${BASE}/avod/streamings?${Q}`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const d = await res.json().catch(() => ({}));
  const si = d?.data?.stream_infos?.[0];
  if (!res.ok || !si?.url) { const e = new Error(d?.errors?.[0]?.message || `rakuten streamings HTTP ${res.status}`); e.code = 'rakuten_error'; throw e; }
  if (si.drm_type || si.license_url) { const e = new Error(`DRM (${si.drm_type})`); e.code = 'rakuten_drm'; throw e; }
  const out = { hls: si.url, expiresAt: Date.now() + TTL_MS };
  cache.set(id, out);
  return out;
}
