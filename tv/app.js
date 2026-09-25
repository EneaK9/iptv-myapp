// IPTV app for the Samsung TV (Tizen 4.0+, Samsung AVPlay). Also runs in a desktop browser for testing (<video> + hls.js).
// Written for the 2018 TV's Chromium 56: no ?. / ?? / object spread / Array.flat / Object.fromEntries / padStart.
(function () {
  'use strict';

  var DATA_URLS = ['https://raw.githubusercontent.com/EneaK9/iptv-myapp/main/data/tv.json', 'tv.json']; // GitHub first, packaged copy second
  var STREAM_TIMEOUT = 20000; // no picture after this long: try the next stream
  var ROW_H = 96;
  var TV = typeof tizen !== 'undefined' && typeof webapis !== 'undefined' && !!webapis.avplay;
  var IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('iptv.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('iptv.' + k, JSON.stringify(v)); } catch (e) { /* full: not important */ } }
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---- on-screen debug log (blue button, or "d" on a keyboard) ----
  var logLines = [];
  function log(m) {
    var t = new Date();
    logLines.unshift(pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) + '  ' + m);
    if (logLines.length > 45) logLines.length = 45;
    $('debug').textContent = logLines.join('\n');
    if (!TV && window.console) console.log(m);
  }
  var toastTimer;
  function toast(m) { var el = $('toast'); el.textContent = m; el.className = 'show'; clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.className = ''; }, 3500); }

  function withTimeout(p, ms, what) { return Promise.race([p, new Promise(function (_, reject) { setTimeout(function () { reject(new Error(what + ' timed out')); }, ms); })]); }
  function request(url, opts) {
    return withTimeout(fetch(url, opts || {}), 15000, 'request').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url.split('?')[0]);
      return r;
    });
  }
  function getJSON(url, opts) { return request(url, opts).then(function (r) { return r.json(); }); }
  function fileJSON(url) { // files inside the installed app: the TV's fetch() cannot read file:// URLs, XMLHttpRequest can
    return new Promise(function (ok, bad) {
      var x = new XMLHttpRequest();
      x.open('GET', url); x.timeout = 15000;
      x.onload = function () { if (x.status === 200 || (x.status === 0 && x.responseText)) { try { ok(JSON.parse(x.responseText)); } catch (e) { bad(e); } } else bad(new Error('HTTP ' + x.status)); };
      x.onerror = function () { bad(new Error('could not read ' + url)); };
      x.ontimeout = function () { bad(new Error(url + ' timed out')); };
      x.send();
    });
  }

  // ---- getting a playable URL: most streams are direct; some need the broadcaster's own "pass" first ----
  var plexToken = null;
  var RESOLVERS = {
    twitch: function (login) { // abcnews.al/live and top-channel.tv/topnewslive embed these Twitch players
      var q = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';
      return getJSON('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ operationName: 'PlaybackAccessToken_Template', query: q, variables: { isLive: true, login: login, isVod: false, vodID: '', playerType: 'embed' } }) })
        .then(function (d) {
          var t = d && d.data && d.data.streamPlaybackAccessToken;
          if (!t || !t.value) throw new Error('twitch: no playback token');
          return { url: 'https://usher.ttvnw.net/api/channel/hls/' + login + '.m3u8?sig=' + t.signature + '&token=' + encodeURIComponent(t.value) +
            '&allow_source=true&allow_audio_only=true&player_backend=mediaplayer&playlist_include_framerate=true&supported_codecs=avc1&p=' + Math.floor(Math.random() * 1e7) };
        });
    },
    plex: function (gridKey) { // Plex free Live TV with the anonymous token its web client uses
      var Q = 'X-Plex-Product=Plex%20Mediaverse&X-Plex-Client-Identifier=iptv-myapp-3f8a1c2e';
      var tok = plexToken ? Promise.resolve(plexToken) : getJSON('https://plex.tv/api/v2/users/anonymous?' + Q, { method: 'POST', headers: { Accept: 'application/json' } })
        .then(function (d) { if (!d.authToken) throw new Error('plex: no token'); plexToken = d.authToken; return plexToken; });
      return tok.then(function (t) { return { url: 'https://epg.provider.plex.tv/library/parts/5e20b730f2f8d5003d739db7-' + gridKey + '.m3u8?X-Plex-Token=' + t + '&' + Q }; });
    },
    reporttv: function () { // report-tv.al's own player asks for a signed playlist
      var base = 'https://deb20stream.duckdns.org';
      return getJSON(base + '/playurl?ttl=3600').then(function (d) { if (!d.url) throw new Error('reporttv: no url'); return { url: new URL(d.url, base).href }; });
    },
    klankosova: function () {
      return getJSON('https://klankosova.tv/api/stream/token').then(function (d) { if (!d.url) throw new Error('klankosova: no url'); return { url: d.url }; });
    },
    rakuten: function (arg) { // Rakuten TV Albania, free channels
      var id = arg.split('?')[0], lang = (/lang=(\w+)/.exec(arg) || [])[1] || 'ENG';
      var body = { content_id: id, content_type: 'live_channels', market_code: 'al', classification_id: 270, device_identifier: 'web', device_serial: 'not_implemented',
        device_stream_video_quality: 'FHD', audio_quality: '2.0', player: 'web:HLS-NONE', audio_language: lang, video_type: 'stream', subtitle_language: 'MIS' };
      return getJSON('https://gizmo.rakuten.tv/v3/avod/streamings?classification_id=270&market_code=al&device_identifier=web&locale=en&device_serial=not_implemented',
        { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
        .then(function (d) {
          var si = d && d.data && d.data.stream_infos && d.data.stream_infos[0];
          if (!si || !si.url) throw new Error('rakuten: no stream');
          if (si.drm_type || si.license_url) throw new Error('rakuten: DRM');
          return { url: si.url };
        });
    },
    mcntv: function () { return Promise.reject(new Error('MCN needs cookies on every request; the TV player cannot send them')); },
    mrt: function (slug) { // play.mrt.com.mk embeds a 30-min signed URL; only the -sat feeds and sobraniski play outside North Macedonia
      return pageMatch('https://play.mrt.com.mk/live/' + slug, /https:\/\/vod-c57\.interspace\.com:443\/channel_abr\/\d+\/playlist\.m3u8\?wmsAuthSign=[^"'\s]+/, 'mrt');
    },
    mediaklikk: function (id) { // M4 Sport (mtv4live), M4 Sport+ (mtv4plus): the player iframe carries playData[0].file
      return request('https://player.mediaklikk.hu/playernew/player.php?video=' + id + '&noflash=yes').then(function (r) { return r.text(); }).then(function (html) {
        var m = /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/.exec(html); if (!m) throw new Error('mediaklikk: no stream in player');
        var u = m[1].replace(/\\\//g, '/'); return { url: u.indexOf('//') === 0 ? 'https:' + u : u };
      });
    },
    rtvslo: function (id) { // RTV Slovenija: tv.slo1 / tv.slo2 / tv.slo3
      return getJSON('https://api.rtvslo.si/ava/getLiveStream/' + id + '?client_id=82013fb3a531d5414f478747c1aca622').then(function (d) {
        var files = (d.response && d.response.mediaFiles) || [], f = files.filter(function (x) { return x.type === 'hls'; })[0];
        if (!f) throw new Error('rtvslo: no hls'); return { url: f.streamer + f.file };
      });
    },
    dailymotion: function (id) {
      return getJSON('https://geo.dailymotion.com/video/' + id + '.json?legacy=true').then(function (d) {
        var q = d.qualities && d.qualities.auto && d.qualities.auto[0];
        if (!q || !q.url) throw new Error('dailymotion: ' + ((d.error && d.error.title) || 'no stream')); return { url: q.url };
      });
    },
    crtv: function (id) {
      return getJSON('https://tveapi.acan.group/myapiv2/directplayback/' + id + '/json').then(function (d) {
        var u = d.web_url || d.direct_url; if (!u) throw new Error('crtv: no url'); return { url: u };
      });
    },
    utrk: function (id) { return pageMatch('https://utrk.kg/live/tv?channel=' + id, /https:\/\/st\d*\.mediabay\.tv\/[^'"\s]+\/index\.m3u8\?token=[^'"\s]+/, 'utrk'); }
  };
  function pageMatch(url, re, what) {
    return request(url).then(function (r) { return r.text(); }).then(function (html) {
      var m = re.exec(html.replace(/\\\//g, '/')); if (!m) throw new Error(what + ': no stream link in the page'); return { url: m[0] };
    });
  }
  // AVPlay rejects some master playlists (Twitch's, for one): pick the best video variant and play that directly
  function bestVariant(url) {
    return request(url).then(function (r) { return r.text(); }).then(function (text) {
      if (text.indexOf('#EXT-X-STREAM-INF') < 0) throw new Error('not a master playlist');
      var lines = text.replace(/\r/g, '').split('\n'), best = null, bw = -1;
      for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0 || lines[i].indexOf('RESOLUTION=') < 0) continue; // skip audio-only
        var b = +((/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1] || 0), uri = (lines[i + 1] || '').trim();
        if (uri && uri.charAt(0) !== '#' && b > bw) { bw = b; best = new URL(uri, url).href; }
      }
      if (!best) throw new Error('no video variant');
      return best;
    });
  }
  function resolveYouTube(pageUrl) { // find the live video, then ask YouTube's player API as the Android app does
    var m = /[?&]v=([\w-]{11})/.exec(pageUrl);
    var vid = m ? Promise.resolve(m[1]) : request(pageUrl).then(function (r) { return r.text(); }).then(function (html) {
      var v = /"videoDetails":\{"videoId":"([\w-]{11})"/.exec(html);
      if (!v || !/"isLiveNow":true/.test(html)) throw new Error('youtube: channel is not live now');
      return v[1];
    });
    return vid.then(function (videoId) {
      return getJSON('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': '20.10.38' },
        body: JSON.stringify({ videoId: videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en', gl: 'US' } } }) });
    }).then(function (p) {
      var hls = p && p.streamingData && p.streamingData.hlsManifestUrl;
      if (!hls) throw new Error('youtube: ' + ((p && p.playabilityStatus && p.playabilityStatus.reason) || 'no live stream'));
      return { url: hls, ua: IOS_UA };
    });
  }
  function resolve(s) {
    if (/^https?:/i.test(s.u)) return /youtube\.com|youtu\.be/i.test(s.u) ? resolveYouTube(s.u) : Promise.resolve({ url: s.u });
    var m = /^([a-z]+):\/\/(.*)$/.exec(s.u), fn = m && RESOLVERS[m[1]];
    if (!fn) return Promise.reject(new Error((m ? m[1] : 'this link') + ' is not supported on the TV yet'));
    return fn(m[2]);
  }

  // ---- players: Samsung AVPlay on the TV, <video> + hls.js in a desktop browser ----
  function avPlayer() {
    var av = webapis.avplay;
    function stop() { try { var st = av.getState(); if (st !== 'NONE' && st !== 'IDLE') av.stop(); av.close(); } catch (e) { /* already closed */ } }
    return {
      play: function (url, opts, cb) {
        stop();
        try {
          av.open(url);
          av.setDisplayRect(0, 0, 1920, 1080);
          av.setDisplayMethod('PLAYER_DISPLAY_MODE_FULL_SCREEN');
          if (opts.ua) av.setStreamingProperty('USER_AGENT', opts.ua);
          av.setListener({
            onbufferingstart: function () { cb.buffering(true); },
            onbufferingcomplete: function () { cb.buffering(false); },
            onstreamcompleted: function () { cb.error('stream ended'); },
            onerror: function (e) { cb.error('player error ' + e); },
            onevent: function () {}, oncurrentplaytime: function () {}
          });
          av.prepareAsync(function () { av.play(); cb.playing(); }, function (e) { cb.error('cannot open stream (' + (e && e.name || e) + ')'); });
        } catch (e) { cb.error(e.message || String(e)); }
      },
      stop: stop,
      pause: function () { try { av.pause(); } catch (e) {} },
      jump: function (sec) { try { if (sec > 0) av.jumpForward(sec * 1000); else av.jumpBackward(-sec * 1000); return true; } catch (e) { return false; } }
    };
  }
  function htmlPlayer() {
    var v = $('vid'), hls = null;
    // desktop testing only: served by scripts/serve.mjs, play through its proxy (desktop browsers enforce CORS on video, the TV player does not)
    var viaProxy = /^\/tv\//.test(location.pathname) && location.protocol.indexOf('http') === 0;
    var src = function (url) { return viaProxy ? '/proxy?u=' + encodeURIComponent(url) : url; };
    function stop() { if (hls) { hls.destroy(); hls = null; } v.onplaying = v.onwaiting = v.onerror = null; v.removeAttribute('src'); try { v.load(); } catch (e) {} }
    return {
      play: function (url, opts, cb) {
        stop();
        v.onplaying = function () { cb.playing(); cb.buffering(false); };
        v.onwaiting = function () { cb.buffering(true); };
        if (!opts.audio && window.Hls && Hls.isSupported()) {
          hls = new Hls({ manifestLoadingTimeOut: 15000 });
          hls.on(Hls.Events.ERROR, function (_, d) { if (d.fatal) cb.error('hls.js ' + d.details + (d.response ? ' HTTP ' + d.response.code : '')); });
          hls.loadSource(src(url)); hls.attachMedia(v);
        } else { v.src = src(url); v.onerror = function () { cb.error('media error'); }; }
        var p = v.play(); if (p && p.catch) p.catch(function () {});
      },
      stop: stop,
      pause: function () { v.pause(); },
      jump: function (sec) { try { v.currentTime += sec; return true; } catch (e) { return false; } }
    };
  }
  var player = TV ? avPlayer() : htmlPlayer();

  // ---- channel lists ----
  function hasCat(c, cats) { if (!c.g) return false; for (var i = 0; i < cats.length; i++) if (c.g.indexOf(cats[i]) >= 0) return true; return false; }
  var SECTIONS = [
    { id: 'sq', label: 'Shqip', ic: 'AL', col: '#dc2626', f: function (c) { return c.sq; } },
    { id: 'recent', label: 'Recent', ic: 'H', col: '#475569' },
    { id: 'sports', label: 'Sports', ic: 'S', col: '#16a34a', f: function (c) { return hasCat(c, ['sports']); } },
    { id: 'news', label: 'News', ic: 'N', col: '#2563eb', f: function (c) { return hasCat(c, ['news']); } },
    { id: 'movies', label: 'Movies', ic: 'F', col: '#9333ea', f: function (c) { return hasCat(c, ['movies', 'series']); } },
    { id: 'kids', label: 'Kids', ic: 'K', col: '#f59e0b', f: function (c) { return hasCat(c, ['kids', 'animation']); } },
    { id: 'music', label: 'Music', ic: 'M', col: '#db2777', f: function (c) { return hasCat(c, ['music']); } },
    { id: 'radio', label: 'Radio', ic: 'FM', col: '#0891b2', f: function (c) { return hasCat(c, ['radio']); } },
    { id: 'countries', label: 'Countries', ic: 'W', col: '#64748b' }
  ];
  var data = null, byId = {}, lists = {};
  var ui = { zone: 'rail', sec: 0, focusSec: 0, idx: 0, top: 0, country: null, browse: true };
  var cur = { list: null, key: null, pos: -1, ch: null, streams: [], si: 0, tried: 0, state: 'idle', token: 0, timer: null, lastRetry: 0 };

  function listFor(key) {
    if (key === 'recent') return store.get('recent', []).map(function (id) { return byId[id]; }).filter(Boolean); // not cached: changes as you watch
    if (lists[key]) return lists[key];
    var f;
    if (key.indexOf('c:') === 0) { var cc = key.slice(2); f = function (c) { return c.c === cc; }; }
    else f = SECTIONS.filter(function (s) { return s.id === key; })[0].f;
    return (lists[key] = data.channels.filter(f));
  }
  function countryList() {
    if (lists._countries) return lists._countries;
    var counts = {};
    data.channels.forEach(function (c) { if (c.c && c.h <= 1) counts[c.c] = (counts[c.c] || 0) + 1; });
    return (lists._countries = Object.keys(counts).map(function (k) { return { country: k, name: (data.countries && data.countries[k]) || k, count: counts[k] }; })
      .sort(function (a, b) { return b.count - a.count; }));
  }
  function panelKey() { var s = SECTIONS[ui.sec]; return s.id === 'countries' ? (ui.country ? 'c:' + ui.country : null) : s.id; }
  function panelItems() { var k = panelKey(); return k ? listFor(k) : countryList(); }

  // ---- drawing ----
  function logoHtml(c) {
    var ini = (c.n.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
    var bg = c.l ? ' style="background-image:url(&quot;' + esc(c.l) + '&quot;)"' : '';
    return '<div class="logo"' + bg + '>' + (c.l ? '' : '<span class="ini">' + esc(ini) + '</span>') + '<i class="dot h' + c.h + '"></i></div>';
  }
  function metaText(c) {
    var parts = [];
    if (c.c) parts.push((data.countries && data.countries[c.c]) || c.c);
    if (c.g) parts.push(c.g.slice(0, 2).join(', '));
    if (c.h === 1) parts.push('worked recently'); else if (c.h === 3) parts.push('down at the last check');
    return parts.join(' · ');
  }
  function renderRail() {
    $('rail').innerHTML = SECTIONS.map(function (s, i) {
      var cls = 'sec' + (i === ui.sec ? ' on' : '') + (ui.zone === 'rail' && i === ui.focusSec ? ' focus' : '');
      return '<div class="' + cls + '"><span class="ic" style="background:' + s.col + '">' + s.ic + '</span>' + s.label + '</div>';
    }).join('');
  }
  function visibleRows() { return Math.max(1, Math.floor($('rows').clientHeight / ROW_H)); }
  function renderRows() {
    var items = panelItems(), vis = visibleRows(), s = SECTIONS[ui.sec];
    if (ui.idx >= items.length) ui.idx = Math.max(0, items.length - 1);
    if (ui.idx < ui.top) ui.top = ui.idx;
    if (ui.idx >= ui.top + vis) ui.top = ui.idx - vis + 1;
    $('title').textContent = ui.country ? ((data.countries && data.countries[ui.country]) || ui.country) : s.label;
    $('sub').textContent = items.length + (panelKey() ? ' channels' : ' countries');
    var html = '';
    for (var i = ui.top; i < Math.min(items.length, ui.top + vis); i++) {
      var it = items[i], focus = ui.zone === 'list' && i === ui.idx, y = (i - ui.top) * ROW_H;
      if (it.country) {
        html += '<div class="row' + (focus ? ' focus' : '') + '" style="top:' + y + 'px"><div class="logo"><span class="ini">' + esc(it.country) + '</span></div>' +
          '<div class="tx"><div class="nm">' + esc(it.name) + '</div></div><div class="cnt">' + it.count + '</div></div>';
      } else {
        html += '<div class="row' + (focus ? ' focus' : '') + (cur.ch === it ? ' playing' : '') + '" style="top:' + y + 'px">' + logoHtml(it) +
          '<div class="tx"><div class="nm">' + esc(it.n) + '</div><div class="mt">' + esc(metaText(it)) + '</div></div>' + (it.s.length > 1 ? '<div class="cnt">' + it.s.length + '</div>' : '') + '</div>';
      }
    }
    $('rows').innerHTML = html || '<div class="empty">' + (s.id === 'recent' ? 'Channels you watch will show up here.' : 'Nothing here.') + '</div>';
  }
  function render() { renderRail(); renderRows(); }
  function showBrowse(on) {
    ui.browse = on;
    $('browse').className = on ? '' : 'hidden';
    document.body.classList.toggle('idle', !cur.ch);
    if (on) { hideBanner(); render(); }
  }

  // ---- now-playing banner ----
  var bannerTimer;
  function showBanner() {
    var c = cur.ch; if (!c) return;
    $('b-logo').outerHTML = logoHtml(c).replace('<div class="logo"', '<div id="b-logo" class="logo"');
    $('b-name').textContent = c.n;
    $('b-meta').textContent = 'Stream ' + (cur.si + 1) + ' of ' + cur.streams.length + (c.c ? ' · ' + ((data.countries && data.countries[c.c]) || c.c) : '');
    updateBannerState();
    $('banner').className = '';
    clearTimeout(bannerTimer);
    if (cur.state === 'playing') bannerTimer = setTimeout(hideBanner, 5000);
  }
  function updateBannerState() {
    var el = $('b-state'), map = { connecting: ['Connecting…', 'wait'], buffering: ['Buffering…', 'wait'], playing: ['● LIVE', 'live'], paused: ['Paused · ▶ for live', 'wait'], failed: ['No stream works right now', 'bad'] };
    var st = map[cur.state] || ['', ''];
    el.textContent = st[0]; el.className = st[1];
  }
  function hideBanner() { clearTimeout(bannerTimer); $('banner').className = 'hidden'; }

  // ---- playing ----
  function play(list, key, pos) {
    var ch = list[pos]; if (!ch) return;
    cur.list = list; cur.key = key; cur.pos = pos; cur.ch = ch;
    var best = store.get('best', {})[ch.i]; // the stream that worked last time goes first
    cur.streams = ch.s.slice().sort(function (a, b) { return (b.u === best) - (a.u === best); });
    cur.tried = 0;
    startStream(0);
    var recent = store.get('recent', []).filter(function (id) { return id !== ch.i; });
    recent.unshift(ch.i); store.set('recent', recent.slice(0, 30));
    store.set('last', { id: ch.i, key: key });
    document.body.classList.remove('idle');
  }
  function startStream(si) {
    var token = ++cur.token, s = cur.streams[si];
    cur.si = si; cur.state = 'connecting';
    showBanner();
    log('▶ ' + cur.ch.n + ' #' + (si + 1) + '  ' + s.u);
    clearTimeout(cur.timer);
    cur.timer = setTimeout(function () { if (token === cur.token && cur.state === 'connecting') fail('no picture after ' + STREAM_TIMEOUT / 1000 + ' s'); }, STREAM_TIMEOUT);
    resolve(s).then(function (r) {
      if (token !== cur.token) return;
      var opts = { ua: r.ua || s.ua, audio: !!s.a }, triedVariant = false;
      var cbs = {
        playing: function () {
          if (token !== cur.token) return;
          cur.state = 'playing'; clearTimeout(cur.timer); log('✓ playing');
          var best = store.get('best', {}); best[cur.ch.i] = s.u; store.set('best', best);
          showBanner();
        },
        buffering: function (on) {
          if (token !== cur.token || (cur.state !== 'playing' && cur.state !== 'buffering')) return;
          cur.state = on ? 'buffering' : 'playing'; updateBannerState();
        },
        error: function (m) {
          if (token !== cur.token) return;
          if (cur.state === 'playing' || cur.state === 'buffering') { // a hiccup in a stream that was working: reconnect once a minute
            if (Date.now() - cur.lastRetry > 60000) { cur.lastRetry = Date.now(); log('↻ ' + m + ', reconnecting'); startStream(cur.si); return; }
          }
          if (!triedVariant && !opts.audio && /^cannot open stream/.test(m) && /^https?:/.test(r.url)) { // e.g. Twitch: AVPlay rejects the master playlist
            triedVariant = true; log('↻ ' + m + ', trying the best variant');
            bestVariant(r.url).then(function (v) { if (token === cur.token) player.play(v, opts, cbs); }, function (e) { if (token === cur.token) fail(m + ' (' + e.message + ')'); });
            return;
          }
          fail(m);
        }
      };
      player.play(r.url, opts, cbs);
    }, function (e) { if (token === cur.token) fail(e.message || String(e)); });
  }
  function fail(reason) {
    log('✖ ' + reason);
    cur.tried++;
    if (cur.tried >= cur.streams.length) { cur.state = 'failed'; cur.token++; clearTimeout(cur.timer); player.stop(); showBanner(); return; }
    startStream((cur.si + 1) % cur.streams.length);
  }
  function switchStream(si) {
    if (!cur.ch || si < 0 || si >= cur.streams.length) return;
    cur.tried = 0; startStream(si);
  }
  function zap(delta) {
    if (!cur.list || !cur.list.length) return;
    var pos = (cur.pos + delta + cur.list.length) % cur.list.length;
    play(cur.list, cur.key, pos);
  }
  function togglePause() {
    if (!cur.ch) return;
    if (cur.state === 'paused') { cur.tried = 0; startStream(cur.si); return; } // resume = back to live
    if (cur.state === 'playing' || cur.state === 'buffering') { player.pause(); cur.token++; cur.state = 'paused'; showBanner(); clearTimeout(bannerTimer); }
  }

  // ---- remote control ----
  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back', 27: 'back', 8: 'back', 461: 'back',
    10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 412: 'rew', 417: 'ff', 427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown',
    403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info' };
  function keyName(e) {
    if (e.keyCode >= 48 && e.keyCode <= 57) return 'd' + (e.keyCode - 48);
    if (!TV && e.key === ' ') return 'playpause';
    if (!TV && (e.key === 'd' || e.key === 'D')) return 'blue';
    return KEYS[e.keyCode] || null;
  }
  function onKey(e) {
    var k = keyName(e); if (!k) return;
    e.preventDefault();
    if (k === 'blue') { $('debug').classList.toggle('show'); return; }
    if (ui.browse) browseKey(k); else playerKey(k);
  }
  function openSection(i) {
    if (ui.sec !== i) { ui.sec = i; ui.idx = 0; ui.top = 0; ui.country = null; }
    ui.zone = 'list'; render();
  }
  function browseKey(k) {
    var items = panelItems(), vis = visibleRows();
    if (ui.zone === 'rail') {
      if (k === 'up') ui.focusSec = Math.max(0, ui.focusSec - 1);
      else if (k === 'down') ui.focusSec = Math.min(SECTIONS.length - 1, ui.focusSec + 1);
      else if (k === 'ok' || k === 'right') return openSection(ui.focusSec);
      else if (k === 'back') { if (cur.ch && cur.state !== 'failed') return showBrowse(false); return exitApp(); }
      renderRail(); return;
    }
    if (k === 'up') ui.idx = Math.max(0, ui.idx - 1);
    else if (k === 'down') ui.idx = Math.min(items.length - 1, ui.idx + 1);
    else if (k === 'chup') ui.idx = Math.max(0, ui.idx - vis);
    else if (k === 'chdown') ui.idx = Math.min(items.length - 1, ui.idx + vis);
    else if (k === 'left') { ui.zone = 'rail'; ui.focusSec = ui.sec; return render(); }
    else if (k === 'ok') {
      var it = items[ui.idx]; if (!it) return;
      if (it.country) { ui.country = it.country; ui.idx = 0; ui.top = 0; return renderRows(); }
      play(items, panelKey(), ui.idx); return showBrowse(false);
    } else if (k === 'back') {
      if (ui.country) { var from = ui.country; ui.country = null; ui.idx = Math.max(0, countryList().map(function (c) { return c.country; }).indexOf(from)); ui.top = 0; return renderRows(); }
      if (cur.ch) return showBrowse(false);
      ui.zone = 'rail'; ui.focusSec = ui.sec; return render();
    } else if (/^d[1-9]$/.test(k) && cur.ch) { switchStream(+k.slice(1) - 1); return; }
    else if (k === 'playpause' || k === 'play' || k === 'pause') return togglePause();
    renderRows();
  }
  function playerKey(k) {
    if (k === 'ok' || k === 'back') {
      if (cur.key) { // open the list where the playing channel is
        var secIdx = -1;
        SECTIONS.forEach(function (s, i) { if (s.id === cur.key || (cur.key.indexOf('c:') === 0 && s.id === 'countries')) secIdx = i; });
        if (secIdx >= 0) { ui.sec = ui.focusSec = secIdx; ui.country = cur.key.indexOf('c:') === 0 ? cur.key.slice(2) : null; ui.idx = cur.pos; ui.top = Math.max(0, cur.pos - 3); ui.zone = 'list'; }
      }
      return showBrowse(true);
    }
    if (k === 'up' || k === 'chdown') return zap(-1);
    if (k === 'down' || k === 'chup') return zap(1);
    if (k === 'left') return switchStream((cur.si - 1 + cur.streams.length) % cur.streams.length);
    if (k === 'right') return switchStream((cur.si + 1) % cur.streams.length);
    if (/^d[1-9]$/.test(k)) return switchStream(+k.slice(1) - 1);
    if (k === 'playpause' || k === 'play' || k === 'pause') return togglePause();
    if (k === 'stop') { cur.token++; player.stop(); cur.state = 'paused'; return showBanner(); }
    if (k === 'rew' || k === 'ff') { if (!player.jump(k === 'ff' ? 10 : -10)) toast('This stream cannot rewind'); return; }
    if (k === 'red') { cur.tried = 0; return startStream(cur.si); } // back to live
    if (k === 'info' || k === 'green' || k === 'yellow') return showBanner();
  }
  // test hook for remote debugging (DevTools on the TV): iptvTest.play('Report TV'), iptvTest.state()
  window.iptvTest = {
    play: function (name, si) {
      var list = data.channels.filter(function (c) { return c.n === name; });
      if (!list.length) return 'no channel ' + name;
      play(list, cur.key || 'sq', 0); if (si) switchStream(si); showBrowse(false); return 'started ' + name;
    },
    state: function () { return { channel: cur.ch && cur.ch.n, stream: cur.si + 1, of: cur.streams.length, state: cur.state, log: logLines.slice(0, 6) }; }
  };
  function exitApp() { if (TV) { try { tizen.application.getCurrentApplication().exit(); } catch (e) {} } else toast('(on the TV this exits the app)'); }
  function registerKeys() {
    if (!TV || !tizen.tvinputdevice) return;
    var want = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'ChannelUp', 'ChannelDown',
      'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    want.forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e) { log('key ' + k + ' not available'); } });
  }

  // ---- start ----
  function fit() { var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080); $('stage').style.transform = s === 1 ? '' : 'scale(' + s + ')'; }
  function loadData(i) {
    if (i >= DATA_URLS.length) return Promise.reject(new Error('could not load the channel list'));
    return (/^https?:/.test(DATA_URLS[i]) ? getJSON(DATA_URLS[i]) : fileJSON(DATA_URLS[i])).then(function (d) { log('channel list: ' + d.channels.length + ' channels (' + DATA_URLS[i] + ', ' + d.generated + ')'); return d; },
      function (e) { log('channel list from ' + DATA_URLS[i] + ' failed: ' + e.message); return loadData(i + 1); });
  }
  function loadScript(src) { return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }

  function start() {
    if (!TV) document.body.classList.add('desktop');
    document.body.classList.add('idle');
    fit(); window.addEventListener('resize', function () { fit(); if (data) renderRows(); });
    document.addEventListener('keydown', onKey);
    registerKeys();
    document.addEventListener('visibilitychange', function () { // the TV suspends apps in the background: stop, then resume live
      if (document.hidden) { cur.token++; player.stop(); }
      else if (cur.ch && cur.state !== 'failed' && cur.state !== 'paused') { cur.tried = 0; startStream(cur.si); }
    });
    log(TV ? 'Samsung TV, AVPlay' : 'desktop browser test mode');
    var ready = TV ? Promise.resolve() : loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').catch(function () { log('hls.js did not load'); });
    Promise.all([loadData(0), ready]).then(function (res) {
      data = res[0];
      data.channels.forEach(function (c) { byId[c.i] = c; });
      render();
      var last = store.get('last', null); // start on the channel you watched last, like a TV does
      if (last && byId[last.id]) {
        var key = last.key || 'sq', list = listFor(key.indexOf('c:') === 0 || key === 'recent' || SECTIONS.some(function (s) { return s.id === key; }) ? key : 'sq');
        var pos = list.indexOf(byId[last.id]);
        if (pos < 0) { list = [byId[last.id]]; pos = 0; }
        play(list, key, pos); showBrowse(false);
      } else { ui.zone = 'list'; showBrowse(true); }
    }, function (e) { $('rows').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; log(e.message); });
  }
  start();
})();
