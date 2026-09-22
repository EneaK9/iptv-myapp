// Import channels from a LOCAL DVB-T2 tuner on the LAN (free-to-air antenna reception) so they join the database.
// Supported: HDHomeRun (lineup.json), Tvheadend (playlist/channels.m3u), or any M3U URL. Config: sources/local-tuner.json
import { readFile } from 'node:fs/promises';
import { parseM3U } from './m3u.mjs';

// over-the-air names -> our channel ids (extend as your scan reveals names)
export const TUNER_MAP = [
  [/^top ?channel/i, 'TopChannel.al'], [/^(tv )?klan( hd)?$/i, 'TVKlan.al'], [/klan plus/i, 'KlanPlus.al'], [/klan news/i, 'KlanNews.al'], [/klan music/i, 'KlanMusic.al'],
  [/rtsh ?24/i, 'RTSH24.al'], [/^rtsh ?1\b/i, 'RTSH1.al'], [/^rtsh ?2\b/i, 'RTSH2.al'], [/^rtsh ?3\b/i, 'RTSH3.al'], [/rtsh ?sport/i, 'RTSHSport.al'], [/rtsh ?shqip/i, 'RTSHShqip.al'],
  [/rtsh ?film/i, 'RTSHFilm.al'], [/rtsh ?muzik/i, 'RTSHMuzike.al'], [/rtsh ?f[eë]mij/i, 'RTSHFemije.al'], [/rtsh ?plus/i, 'RTSHPlus.al'], [/rtsh ?kuvend/i, 'RTSHKuvend.al'], [/rtsh ?shkoll/i, 'RTSHShkolle.al'], [/rtsh ?agro/i, 'RTSHAgro.al'],
  [/vizion ?plus/i, 'VizionPlus.al'], [/news ?24/i, 'News24.al'], [/^abc( news)?/i, 'ABCNewsAlbania.al'], [/report ?tv/i, 'ReportTV.al'], [/ora ?news/i, 'OraNews.al'], [/^syri/i, 'Syri.al'],
  [/a2 ?cnn/i, 'A2CNN.al'], [/euronews/i, 'EuronewsAlbania.al'], [/^scan/i, 'ScanTV.al'], [/^in ?tv/i, 'INTV.al'], [/fax ?news/i, 'FaxNews.al'], [/^mcn/i, 'MCNTV.al'], [/^rtk ?1/i, 'RTK1.xk'], [/^shijak/i, 'ShijakTV.al'], [/^club ?tv/i, 'ClubTV.al'], [/^utv/i, 'UTVNews.al'], [/^bbf/i, 'BBFTV.al'],
];
export const mapTunerName = name => TUNER_MAP.find(([re]) => re.test(name.trim()))?.[1] ?? null;

async function getText(url, auth) {
  const headers = { 'user-agent': 'iptv-myapp/0.1' };
  if (auth?.user) headers.authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass ?? ''}`).toString('base64');
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function fetchTunerChannels(configPath = new URL('../sources/local-tuner.json', import.meta.url)) {
  let cfg;
  try { cfg = JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const country = cfg.country ?? 'AL';
  let items = [];
  if (cfg.hdhomerun?.host) {
    const lineup = JSON.parse(await getText(`http://${cfg.hdhomerun.host}/lineup.json`));
    items = lineup.filter(l => !l.DRM).map(l => ({ name: l.GuideName, number: l.GuideNumber, url: l.URL, encrypted: !!l.DRM, kind: 'hdhomerun' }));
  } else if (cfg.tvheadend?.url) {
    const base = cfg.tvheadend.url.replace(/\/$/, '');
    const m3u = await getText(`${base}/playlist/channels.m3u?profile=${encodeURIComponent(cfg.tvheadend.profile ?? 'pass')}`, cfg.tvheadend);
    items = parseM3U(m3u).map(it => ({ name: it.name, number: it.attrs['tvg-chno'] ?? null, url: it.url, logo: it.attrs['tvg-logo'] ?? null, kind: 'tvheadend' }));
  } else if (cfg.m3u?.url) {
    items = parseM3U(await getText(cfg.m3u.url)).map(it => ({ name: it.name, number: it.attrs['tvg-chno'] ?? null, url: it.url, logo: it.attrs['tvg-logo'] ?? null, kind: 'm3u' }));
  } else throw new Error('local-tuner.json: no hdhomerun/tvheadend/m3u block');
  return items.map(it => ({ ...it, country, channel: mapTunerName(it.name) }));
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await fetchTunerChannels(), null, 1));
