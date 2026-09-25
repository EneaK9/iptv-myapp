// Nearest digital-TV (DVB-T2) transmitters for a place in Albania/Kosovo: distance, which way to point the antenna,
// whether hills block the path, and the frequencies to expect. The TV's own tuner does the receiving; this only
// tells you which antenna to get and where to point it.
//
//   node scripts/towers.mjs "Kamëz"              # any place name (looked up on OpenStreetMap)
//   node scripts/towers.mjs 41.3275,19.8187      # or coordinates (right-click in Google Maps copies them)
//   node scripts/towers.mjs Tirana --indoor      # judge for an indoor antenna (default: rooftop, 10 m)
//   node scripts/towers.mjs Tirana --json        # machine-readable
import { readFile } from 'node:fs/promises';

const DATA = new URL('../sources/al-dvbt2-transmitters.json', import.meta.url);
const UA = 'iptv-myapp/0.1 (personal TV antenna helper)';
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const query = args.filter(a => !a.startsWith('--')).join(' ').trim();
if (!query) { console.log('usage: node scripts/towers.mjs "<place>" | <lat>,<lon> [--indoor] [--json] [--all]'); process.exit(1); }

const { muxes, sites } = JSON.parse(await readFile(DATA, 'utf8'));
const rxHeight = flag('--indoor') ? 4 : 10; // m above ground: indoor ~ first/second floor, rooftop ~ 10 m

// ---- where are we ----
async function locate(q) {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { name: `${m[1]}, ${m[2]}`, lat: +m[1], lon: +m[2] };
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=al,xk,mk,me&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sq,en' }, signal: AbortSignal.timeout(15_000) });
  const [hit] = await r.json();
  if (!hit) throw new Error(`place not found: ${q}`);
  const a = hit.address ?? {};
  return { name: hit.display_name.split(',').slice(0, 3).join(','), lat: +hit.lat, lon: +hit.lon,
    towns: [q, a.city, a.town, a.village, a.suburb, a.municipality].filter(Boolean) };
}
// towers list the towns they serve; match those against the place we looked up (Tiranë = Tirana, Kamëz = Kamez)
const fold = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').trim();
const stem = s => fold(s).replace(/\b(\w{4,}?)[eaiu]?\b/g, '$1'); // drop the Albanian definite ending: Tiranë/Tirana -> tiran
const servesHere = (site, towns) => site.serves.some(t => t.split(/[\/(),]/).some(part => part.trim() && towns.some(q => stem(q) === stem(part))));

// ---- geometry ----
const rad = d => d * Math.PI / 180, R = 6371;
function distanceKm(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];
const SQ_DIR = { N: 'veri', NNE: 'veri-verilindje', NE: 'verilindje', ENE: 'lindje-verilindje', E: 'lindje', ESE: 'lindje-juglindje', SE: 'juglindje', SSE: 'jug-juglindje',
  S: 'jug', SSW: 'jug-jugperëndim', SW: 'jugperëndim', WSW: 'perëndim-jugperëndim', W: 'perëndim', WNW: 'perëndim-veriperëndim', NW: 'veriperëndim', NNW: 'veri-veriperëndim' };

// ---- terrain: does the straight line tower -> antenna clear the ground? (Copernicus 90 m DEM via Open-Meteo) ----
async function elevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) { // API takes up to 100 points per call
    const chunk = points.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(p => p.lat.toFixed(5)).join(',')}&longitude=${chunk.map(p => p.lon.toFixed(5)).join(',')}`;
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 && attempt < 5) { await new Promise(res => setTimeout(res, 3000 * attempt)); continue; } // free API, rate-limited per minute
      if (!r.ok) throw new Error(`elevation API HTTP ${r.status}`);
      out.push(...(await r.json()).elevation); break;
    }
  }
  return out;
}
async function pathCheck(rx, site, km) {
  const n = Math.min(200, Math.max(40, Math.round(km * 4))); // a sample every ~250 m
  const pts = Array.from({ length: n + 1 }, (_, i) => ({ lat: rx.lat + (site.lat - rx.lat) * i / n, lon: rx.lon + (site.lon - rx.lon) * i / n }));
  const ground = await elevations(pts);
  const rxH = ground[0] + rxHeight;
  const txH = Math.max(ground[n], site.altM ?? ground[n]) + (site.mastM ?? 30);
  const midMHz = 306 + 8 * (site.muxes[0]?.uhf ?? 40), lambda = 300 / midMHz / 1000; // km
  let worst = Infinity, worstAt = 0;
  for (let i = 1; i < n; i++) {
    const d1 = km * i / n, d2 = km - d1;
    const line = rxH + (txH - rxH) * i / n;
    const bulge = d1 * d2 / (2 * (4 / 3) * R) * 1000;              // earth curvature with normal refraction, m
    const fresnel = 0.6 * Math.sqrt(lambda * d1 * d2 / km) * 1000;  // 60% of the first Fresnel zone, m
    const clearance = line - (ground[i] + bulge) - fresnel;
    if (clearance < worst) { worst = clearance; worstAt = d1; }
  }
  return { clearanceM: Math.round(worst), obstacleKm: +worstAt.toFixed(1), rxGroundM: Math.round(ground[0]) };
}

function advice(km, path) {
  if (!path) return 'terrain unknown';
  const clear = path.clearanceM >= 0;
  if (clear && km <= 25) return rxHeight < 10 ? 'clear path: an indoor UHF antenna by a window facing the tower should work' : 'clear path: any UHF antenna works; indoor is likely enough';
  if (clear && km <= 60) return 'clear path but far: use an outdoor directional UHF antenna (Yagi / log-periodic) aimed at the tower';
  if (clear) return 'clear path but very far: rooftop directional antenna with an amplifier';
  if (path.clearanceM > -60 && km <= 30) return `a hill ${path.obstacleKm} km away partly blocks it: try a rooftop antenna; indoor may be patchy`;
  return `blocked by terrain ${path.obstacleKm} km away: unlikely without a tall rooftop mast; use another tower or the building's shared antenna`;
}

// ---- main ----
const here = await locate(query);
here.towns ??= [query];
const known = s => s.lat != null && s.lon != null;
// towers that say they serve this town first, then the nearest ones; towers with no known position only show up when they serve it
const ranked = sites.map(s => ({ ...s, serving: servesHere(s, here.towns), km: known(s) ? distanceKm(here, s) : null, deg: known(s) ? bearing(here, s) : null }))
  .filter(s => s.serving || s.km != null)
  .sort((a, b) => (b.serving - a.serving) || ((a.km ?? 1e9) - (b.km ?? 1e9)));
const top = flag('--all') ? ranked : ranked.slice(0, Math.max(4, ranked.filter(s => s.serving).length));
for (const s of top) {
  if (s.km == null) { s.advice = 'tower position unknown: point the antenna towards the nearest big hill with masts, or copy the neighbours\' antennas'; continue; }
  try { s.path = await pathCheck(here, s, s.km); } catch (e) { s.path = null; s.pathError = e.message; }
  s.advice = advice(s.km, s.path);
}
if (flag('--json')) { console.log(JSON.stringify({ here, rxHeight, sites: top }, null, 1)); process.exit(0); }

console.log(`\n${here.name}  (${here.lat.toFixed(4)}, ${here.lon.toFixed(4)}; antenna ${rxHeight} m above ground${top[0]?.path ? `, ground ${top[0].path.rxGroundM} m` : ''})\n`);
// best bet: the reachable tower carrying the most free platforms (RTSH, Klan, Top Channel, Vizion Plus...), nearer wins ties
const freeMuxes = s => new Set(s.muxes.map(m => m.mux).filter(k => muxes[k]?.free.length));
const reachable = top.filter(s => s.path && s.path.clearanceM > -60);
const best = reachable.sort((a, b) => (freeMuxes(b).size - freeMuxes(a).size) || (a.km - b.km))[0];
if (best) {
  const dir = compass(best.deg);
  console.log(`Best bet: point the antenna ${dir} (${SQ_DIR[dir]}, ${Math.round(best.deg)}°) at ${best.site}, ${best.km.toFixed(1)} km away.`);
  console.log(`It carries ${[...freeMuxes(best)].map(k => muxes[k].name).join(', ')}. ${best.advice[0].toUpperCase()}${best.advice.slice(1)}.`);
  // free antenna from a spare TV cable (c't "sleeve dipole"): each half is a quarter wave, 7500 / MHz cm
  const mhz = best.muxes.filter(m => m.uhf && muxes[m.mux]?.free.length).map(m => 306 + 8 * m.uhf);
  if (mhz.length) {
    const lo = Math.min(...mhz), hi = Math.max(...mhz), cm = f => (7500 / f).toFixed(1);
    console.log(`No antenna yet? Strip a spare TV cable: fold ${cm((lo + hi) / 2)} cm of braid back over the jacket and leave ${cm((lo + hi) / 2)} cm of bare centre wire`);
    console.log(`(up to ${cm(lo)} cm favours ${lo} MHz, down to ${cm(hi)} cm favours ${hi} MHz). Hang it at a window facing ${compass(best.deg)}, then run Auto Tuning.`);
  }
  console.log();
}
const shown = new Set(); // print each platform's channel list once
for (const [i, s] of top.entries()) {
  const serving = s.serving ? `  ★ serves ${here.towns[here.towns.length > 1 ? 1 : 0]}` : '';
  if (s.km == null) { console.log(`${i + 1}. ${s.site} (${s.region})${serving}\n   → ${s.advice}`); }
  else {
    const dir = compass(s.deg);
    const path = s.path ? (s.path.clearanceM >= 0 ? `clear line of sight (+${s.path.clearanceM} m)` : `terrain in the way (${s.path.clearanceM} m at ${s.path.obstacleKm} km)`) : `terrain check failed: ${s.pathError}`;
    const approx = s.coordConfidence === 'unverified' ? ' (tower position approximate)' : '';
    console.log(`${i + 1}. ${s.site} (${s.region})${serving}\n   ${s.km.toFixed(1)} km, point the antenna ${dir} ${Math.round(s.deg)}° (${SQ_DIR[dir]}), ${path}${approx}`);
    console.log(`   → ${s.advice}`);
  }
  for (const m of [...s.muxes].sort((a, b) => (a.uhf ?? 99) - (b.uhf ?? 99))) {
    const mx = muxes[m.mux] ?? { name: m.mux, free: [], pay: [] };
    const what = shown.has(m.mux) ? '' : [mx.free.length ? `free: ${mx.free.join(', ')}` : '', mx.pay.length ? `pay: ${mx.pay.join(', ')}` : ''].filter(Boolean).join(' | ');
    shown.add(m.mux);
    const freq = m.uhf ? `UHF ${String(m.uhf).padStart(2)}  ${306 + 8 * m.uhf} MHz` : 'UHF ??  (not published)';
    console.log(`   ${freq}  ${m.pol ? `${m.pol}  ` : ''}${mx.name}${what ? ` — ${what}` : ''}${m.confidence && m.confidence !== 'confirmed' ? `  [${m.confidence}]` : ''}`);
  }
  console.log();
}
const pols = new Set(top.flatMap(s => s.muxes.map(m => m.pol)).filter(Boolean));
if (pols.size === 1) console.log(`Polarisation is ${[...pols][0] === 'H' ? 'horizontal: mount the antenna with its rods lying flat' : 'vertical: mount the antenna with its rods standing up'}.`);
if (top.some(s => s.muxes.some(m => m.uhf == null))) console.log('"not published" channels: the operator broadcasts there but does not say on which channel; the auto scan finds them.');
if (top.some(s => s.muxes.some(m => m.uhf >= 49))) console.log('UHF 49-60 is being cleared for mobile (700 MHz band): those channels will move, so re-run the TV\'s auto scan when they announce it.');
console.log('Line of sight counts hills only, not buildings: in a city, put the antenna on the side of the flat facing the tower.');
console.log('Samsung TV: Settings > Broadcasting > Auto Tuning > Aerial finds everything by itself.');
console.log('If a mux is missing: Broadcasting > Expert Settings > Manual Tuning > Digital, enter the MHz above (x1000 = kHz), bandwidth 8 MHz.');
