# iptv-myapp

Personal IPTV app for a Samsung Tizen smart TV, fed by free public playlists.
Not for distribution. Streams are loaded from public sources at runtime; nothing is rebroadcast.

## Data pipeline (runs on the Mac)

```
npm run fetch    # download iptv-org API JSON, iptv-org + Free-TV playlists, Albanian EPG -> data/raw/
npm run merge    # join everything into data/channels.json (one record per channel, N streams each)
npm run check    # HTTP-level liveness check of every stream URL -> data/health.json
npm run report   # data/report.md + data/channels.checked.json (channels with per-stream health)
npm run pipeline # all four in order
```

Useful env vars for `check`:

| Var | Default | Meaning |
|---|---|---|
| `CONCURRENCY` | 48 | parallel requests |
| `TIMEOUT` | 12000 | ms per request |
| `ONLY` | | comma-separated country codes, e.g. `ONLY=AL,XK`; `SQ` = everything the viewer's Albanian filter shows |
| `NEW_ONLY` | | `1` = only URLs with no result yet |

The checker fetches the manifest, follows a master playlist to its first variant, requires the media
playlist to list segments, then pulls the first 64 KB of the first segment. Statuses:

- `ok` data flows
- `http_403` / `http_404` server refuses or stream gone (403 from `5.254.89.106` is a token-protected relay)
- `timeout`, `dns`, `refused`, `reset`, `tls` network-level failures
- `html_page` the URL is a web page (YouTube / Twitch), not a stream
- `bad_manifest`, `no_segments`, `variant_http_*`, `segment_http_*` manifest reachable but stream not usable

Many channels (Albanian locals especially) go off air for hours, so a status is only as good as its age. Each result keeps
`lastOk`, the last time the stream worked. The viewer (`npm run serve`) reads `health.json` live and shows green = worked at
the last check, yellow = failing now but worked in the last 48 h (kept in "alive only"), red = not seen working, and records
every stream that actually plays in the viewer.

**Background rechecker** (`scripts/rechecker.mjs`, started by `npm run serve`, so it runs whenever the viewer server does):
Albanian channels every 30 min (`RECHECK_MIN`), links added by a fetch/merge every hour, everything once a day
(`RECHECK_FULL_H`, ~40 min and ~2 GB per run, ~900 YouTube lookups). `RECHECK=0` turns it off. Last runs are kept in
`data/rechecker.json` so restarts don't repeat the daily run; results are logged to `data/rechecker.log`. Without the viewer:
`npm run rechecker` (scheduler in the foreground) or `npm run rechecker -- albanian` (one job now: `albanian`, `new`, `full`).

## YouTube lives

Some broadcasters (Euronews, France 24, A2 CNN, Euronews Albania, many public broadcasters) stream officially and
free on YouTube. A playlist entry pointing at a YouTube page is not playable by itself, so `scripts/youtube.mjs`
resolves it: it finds the live video on the page, asks YouTube's player API as the Android client, and returns the
HLS manifest (fallback: manifest embedded in the mobile page). Manifests expire after ~6 h and are re-resolved on
demand. The checker marks them `ok` when the resolved stream delivers bytes, `yt_offline` when the channel is not
live. The viewer/proxy resolves them transparently. Twitch page URLs are not supported (two official embeds are, see below).

`sources/official-youtube.json` lists hand-curated official YouTube lives; `sources/official-hls.json` lists hand-verified open
broadcaster HLS/DASH URLs. Both are merged in and tried before other streams of the same channel.

## Additional sources (added after the deep research)

- **Gjirafa Video public API** (`scripts/gjirafa.mjs`): the official player backend of rtklive.com, televizioni7.com, atvlive.tv,
  koha.net. Returns open HLS for RTK 3, RTK 1 Sat, KTV, Arta News, T7, RTV21, ATV, Syri Vision, Euronews Albania 24/7, RTV Besa,
  TV Prizreni, TV News, Zico, PRO1. Paths rotate, so the list is refreshed on every `npm run fetch`. RTK 1/2/4 are Kosovo-only (403).
- **Rakuten TV, Albania market** (`scripts/rakuten.mjs`): 51 free live channels (15 sports: FIFA+, Eurovision Sport, DAZN Ringside,
  Red Bull TV, Man City 24/7, INTER 24/7, TOP Barça, ...). Stream URLs are short-lived, so channels are stored as `rakuten://<id>`
  and resolved on play by the checker and the proxy.
- **FAST playlists** from BuddyChewChew/app-m3u-generator: Samsung TV Plus, Tubi, Roku (Pluto TV serves only ad slates from
  Albania; the checker marks those `slate_only`). The Tubi playlist has returned 404 upstream since 2026-09-23 (cached copy used).
- **Plex free Live TV** (`scripts/plex.mjs`): 182 channels (Tennis TV, Fight Network, SPEEDVISION, PokerGO, Cricket Gold, ...)
  with the anonymous token the watch.plex.tv web client uses. Stored as `plex://<gridKey>`, resolved on play. Plex answers 429
  to bursts, so the checker spaces Plex lookups (`PLEX_SPACING_MS`, default 1500).
- **Famelack** (ex TV Garden, github.com/famelack/famelack-channels, MIT): curated free TV that is re-validated upstream,
  including ~750 YouTube lives (stored as `watch?v=` URLs, refreshed on every fetch). Adds ~440 channels we had no stream for.
- **TDTChannels** (tdtchannels.com): Spanish free-to-air, regional and international channels. RTVE (La 1, +24), Canal Sur and
  most regional broadcasters play from Albania. Both lists join existing channels by name + country, otherwise add new ones.
- **Hand-verified official feeds** in `sources/official-hls.json` (News 24, Syri, Vizion Plus, RTV21, A2 CNN, Teledeporte,
  TyC Sports, beIN XTRA, Red Bull TV, Sportitalia Solocalcio, TVR Sport, L'Equipe, SuperTennis, RugbyPass TV, DFB Play TV,
  TVRI Sport, ...) — tried before other streams of the same channel.

Not used on purpose: pirate relays (e.g. `5.254.89.106`), anything the Albanian prosecution DNS sinkhole
(`you.are.closed.by.law.prosecution.`) covers (TvMAK, albportal.net/AlbKanale, ekranishqip, ...), Twitch channels other than the
two broadcaster embeds below (user's choice),
unofficial restreams of pay channels (SuperSport, Tring Sport, ArtSport, Sky, beIN, DAZN, ...), players that require a sign-in
(Alkass Shoof, SABC+, RugbyPass site) and tokenized players we cannot resolve legitimately (Scan TV, MRT terrestrial geo-block).
`sources/official-dynamic.json` channels are played through the broadcaster's own public player session (`scripts/resolvers.mjs`):
Report TV, MCN TV, Klan Kosova, MRT Sat, M4 Sport/M4 Sport+ (mediaklikk), TV SLO 2 (rtvslo), Sport en France (Dailymotion),
CRTV Sport, KTRK Sport, and (since 2026-09-25) ABC News Albania and Top News as `twitch://<login>`: the Twitch players embedded on
abcnews.al/live and top-channel.tv/topnewslive, resolved with the same anonymous playback token those embeds request.
`sources/official-radio.json`: RTSH radio (Radio Tirana 1/2/3, Fëmijë, Jazz, Klasik, International) and Top Albania Radio,
open Icecast MP3/AAC from the broadcasters' own players; the viewer plays them in the media element (📻 Radio filter).

## Pay TV and paid sports (not in the app; official subscriptions)

Since 2026 DigitAlb and Tring cross-carry each other's sports: DigitAlb Premium (SuperSport 1-7 + Tring Sport 1-7, ~24,900 L/yr)
or Tring Extra (~23,900 L/yr) each give all Albanian pay sports; both have Samsung apps (test the 2018 model with the trial).
Free by antenna: Kategoria Superiore (RTSH Sport), the best UCL Wednesday match (Top Channel, 2026/27), 1 UEL/UECL match a week
(RTSH Sport), Albania national team (TV Klan). Direct subscriptions sold in Albania: DAZN (Samsung 2015+ app; NFL Game Pass, NHL.TV,
FIBA, FIFA+ inside), UFC Fight Pass, Tennis TV, EuroLeague TV (€31.99/yr AL price), MotoGP VideoPass (web only), NBA League Pass
(app needs a 2019+ Samsung). F1 TV is not sold in Albania.

## Local DVB-T2 tuner (free-to-air antenna → your app)

Top Channel, TV Klan, Klan Plus/News, all RTSH channels, Vizion Plus, News 24, ABC, Report TV, Ora News, Syri, A2 CNN and
Euronews Albania are free-to-air on Albania's DVB-T2 platform (AMA free-channel lists; Tirana: Top Channel LCN 5 on UHF 59,
TV Klan LCN 4, RTSH LCN 1-3).

**The target TV has its own DVB-T2 tuner** (UE50NU7022, 2018, Tizen 4.0, one CI+ 1.4 slot). A Tizen web app can show it directly:
`tizen.tvwindow` (show the tuner picture behind a transparent page) and `tizen.tvchannel` (channel list, tune, up/down) are
public-privilege APIs (see Samsung's OverlayPiP sample), so no partner certificate is needed. Only an aerial into the TV is
required; the app then lists antenna channels next to internet streams. The hardware below is only needed to watch
antenna channels on other devices or through the Mac pipeline.

**Which antenna, pointed where:** `npm run towers -- "Kamëz"` (any place name, or `41.33,19.82`; add `--indoor` to judge an
indoor antenna). It lists the nearest transmitters from `sources/al-dvbt2-transmitters.json` (42 Albanian sites: RTSH,
Klan, Top Channel, Media Vizion, DigitAlb; researched 2026-09-24, source per entry), the compass direction, whether hills
block the path (Open-Meteo 90 m terrain, earth curvature, Fresnel zone), and the UHF channels with what is on them.
Frequencies differ per county (RTSH is UHF 21 in Tirana, 23 in Vlorë, 28 in Shkodër, 43 in Korçë). Many tower positions
are the nearest village, and UHF 49-60 (Top Channel, Media Vizion) will move when the 700 MHz band is cleared: re-scan then.
Kosovo has no DVB-T2 network.

A Mac has no tuner, so for that one piece of hardware is needed:

1. **Network tuner** (e.g. HDHomeRun DVB-T2 model): plug into the router, scan once, it serves `http://<tuner>/lineup.json`
   and one MPEG-TS stream per channel. Config: `{"hdhomerun": {"host": "192.168.x.x"}}`.
2. **USB DVB-T2 stick + Tvheadend**: Docker on macOS cannot pass USB through, but a Linux VM (UTM/Parallels) can, or use a
   Raspberry Pi / any Linux box. Tvheadend publishes `/playlist/channels.m3u` and per-channel HTTP streams plus EPG.
   Config: `{"tvheadend": {"url": "http://host:9981", "user": "...", "pass": "...", "profile": "pass"}}`.
3. Any other tuner software that exports an M3U: `{"m3u": {"url": "..."}}`.

Copy `sources/local-tuner.example.json` to `sources/local-tuner.json` (git-ignored), then `npm run fetch && npm run merge`.
Over-the-air channels are mapped to the existing channel records (`TUNER_MAP` in `scripts/tuner.mjs`) and tried first.
Streams are raw MPEG-TS over HTTP: the Samsung AVPlay player handles that natively; the browser viewer uses mpegts.js.
Encrypted (pay) channels reported by the tuner are skipped. Antenna: UHF, pointed at the nearest transmitter (Dajti for Tirana).

## Sources

- iptv-org API: https://iptv-org.github.io/api/ (channels, feeds, streams, logos, guides, blocklist)
- iptv-org playlists: https://iptv-org.github.io/iptv/
- Free-TV curated playlist: https://github.com/Free-TV/IPTV
- Albanian EPG (XMLTV): https://epgshare01.online/epgshare01/epg_ripper_AL1.xml.gz

## Layout

```
scripts/   fetch.mjs, merge.mjs, check.mjs, report.mjs, m3u.mjs
data/      channels.json, channels.checked.json, report.md   (raw downloads and health.json are git-ignored)
```

## Samsung TV app (`tv/`)

Runs on the TV by itself, no computer needed while watching. It downloads `data/tv.json` (compact list built by
`npm run tvdata`: working channels plus all Albanian ones) from GitHub (`raw.githubusercontent.com/EneaK9/iptv-myapp/main`),
falling back to the copy packaged with the app, and plays with Samsung AVPlay. The packaged app is not bound by CORS on
the TV (tested on the UE50NU7022), so streams that need a pass are resolved in the app itself: YouTube, Twitch (AVPlay
rejects Twitch's master playlist, so the app plays the best variant), Plex, Rakuten, Report TV, Klan Kosova, MRT,
mediaklikk, RTV SLO, Dailymotion, CRTV, UTRK. Only MCN (cookies on every request) cannot work on the TV player.
Remote debugging: `sdb shell 0 debug IPTVmyApp0.IPTV` prints a DevTools port reachable at `http://<TV IP>:<port>/json`. Remote: ▲▼ channel, ◀ ▶ or 1-9 stream, OK list, ▶‖ pause (resume = live), ◀◀ ▶▶ ±10 s, red = live, blue = debug log.
The app remembers the stream that worked per channel and starts on the last channel watched. Written for the 2018 TV's
Chromium 56 (no `?.`/`??`/object spread).

- Test on the Mac: `npm run serve`, open `http://localhost:8789/tv/`, arrow keys = remote (desktop plays through the proxy).
- Build + sign: `npm run tv` → `build/IPTV.wgt`, using Samsung's Tizen CLI in Docker (`vitalets/tizen-webos-sdk:3.0`,
  amd64; it does not run natively on Apple Silicon). Author certificate in `~/.iptv-myapp-tizen/` (keep it: the TV only
  accepts updates signed by the same author). The default Tizen distributor certificate is enough on this 2018 TV.
- Install: on the TV open Apps, press 1-2-3-4-5, turn Developer Mode on with Host PC IP = this Mac's IP, restart the TV,
  then `npm run tv -- <TV IP>` (Mac and TV on the same network). Alternative: TizenBrew Installer can install the signed
  `.wgt` from a GitHub release of this repo.

Later: tvwindow for antenna channels (hide AVPlay first; they share the video plane) and tiles that open Klani IM.
