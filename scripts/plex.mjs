// Plex free Live TV (watch.plex.tv). The web client signs in anonymously (POST /api/v2/users/anonymous) and plays
// epg.provider.plex.tv/library/parts/<provider>-<gridKey>.m3u8 with that token. Channel list is fetched at pipeline
// time; streams are stored as plex://<gridKey> and resolved on play (see resolvers.mjs).
const CLIENT = 'iptv-myapp-3f8a1c2e';
const Q = `X-Plex-Product=Plex%20Mediaverse&X-Plex-Client-Identifier=${CLIENT}`;
const H = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' };
const PROVIDER = '5e20b730f2f8d5003d739db7'; // Plex's live-TV provider id, the prefix of every channel's Part key
let token = null, pending = null;

export async function plexToken() {
  if (token && token.expiresAt > Date.now()) return token.value;
  // one sign-in shared by all concurrent callers (the checker resolves dozens of plex:// URLs at once)
  pending ??= (async () => {
    const res = await fetch(`https://plex.tv/api/v2/users/anonymous?${Q}`, { method: 'POST', headers: H, signal: AbortSignal.timeout(15000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.authToken) throw Object.assign(new Error(`plex anonymous sign-in HTTP ${res.status}`), { code: 'resolver_error' });
    token = { value: d.authToken, expiresAt: Date.now() + 12 * 3600 * 1000 };
    return token.value;
  })().finally(() => { pending = null; });
  return pending;
}

export const plexStreamUrl = (gridKey, t) => `https://epg.provider.plex.tv/library/parts/${PROVIDER}-${gridKey}.m3u8?X-Plex-Token=${t}&${Q}`;

export async function fetchPlexChannels() {
  const t = await plexToken();
  const res = await fetch(`https://epg.provider.plex.tv/lineups/plex/channels?X-Plex-Token=${t}&${Q}`, { headers: H, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`plex channels HTTP ${res.status}`);
  const list = (await res.json()).MediaContainer?.Channel ?? [];
  return list.filter(c => !c.hidden && c.gridKey).map(c => ({ gridKey: c.gridKey, title: c.title, logo: c.thumb ?? null, language: c.language ?? null, hd: !!c.isHd }));
}
