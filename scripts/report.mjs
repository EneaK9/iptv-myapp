// Builds data/report.md and data/channels.checked.json from channels.json + health.json
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeStatus } from './status.mjs';
const DATA = new URL('../data/', import.meta.url);
const channels = JSON.parse(await readFile(new URL('channels.json', DATA), 'utf8'));
const health = JSON.parse(await readFile(new URL('health.json', DATA), 'utf8'));
for (const r of Object.values(health)) r.status = normalizeStatus(r.status);
const countries = Object.fromEntries(JSON.parse(await readFile(new URL('raw/iptv-org.countries.json', DATA), 'utf8')).map(c => [c.code, c]));

const ok = s => health[s.url]?.status === 'ok';
for (const c of channels) {
  for (const s of c.streams) { const h = health[s.url]; s.health = h ? { status: h.status, ms: h.ms, kind: h.kind, checkedAt: h.checkedAt } : null; }
  c.alive = c.streams.some(ok);
}
const checked = channels.filter(c => c.streams.some(s => s.health));
const aliveCh = checked.filter(c => c.alive);
const allStreams = checked.flatMap(c => c.streams).filter(s => s.health);
const okStreams = allStreams.filter(ok);

const lines = [];
const L = (...a) => lines.push(a.join(''));
L(`# Stream health report`, `\n`, `Generated ${new Date().toISOString()} from ${process.env.LOCATION ?? 'this machine'}.\n`);
L(`| | Streams | Channels |`, `\n|---|---|---|`);
L(`| Checked | ${allStreams.length} | ${checked.length} |`);
L(`| Alive | ${okStreams.length} (${(100 * okStreams.length / allStreams.length).toFixed(1)}%) | ${aliveCh.length} (${(100 * aliveCh.length / checked.length).toFixed(1)}%) |`);
L(`| Alive, not NSFW | ${okStreams.filter(s => !checked.find(c => c.streams.includes(s))?.isNsfw).length} | ${aliveCh.filter(c => !c.isNsfw).length} |\n`);

L(`## Failure reasons (streams)\n`, `| Status | Count |`, `\n|---|---|`);
const counts = {};
for (const s of allStreams) counts[s.health.status] = (counts[s.health.status] ?? 0) + 1;
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) L(`| ${k} | ${v} |`);

L(`\n## Alive by source\n`, `| Source | Streams checked | Alive |`, `\n|---|---|---|`);
for (const src of ['iptv-org', 'free-tv']) { const ss = allStreams.filter(s => s.source === src); L(`| ${src} | ${ss.length} | ${ss.filter(ok).length} (${(100 * ss.filter(ok).length / Math.max(1, ss.length)).toFixed(1)}%) |`); }

L(`\n## Albanian-language channels (AL, XK, or language sqi)\n`, `| Channel | Country | Alive | Streams (status) |`, `\n|---|---|---|---|`);
const sq = checked.filter(c => c.country === 'AL' || c.country === 'XK' || c.languages.includes('sqi')).sort((a, b) => (b.alive - a.alive) || a.name.localeCompare(b.name));
for (const c of sq) L(`| ${c.name} | ${c.country ?? '?'} | ${c.alive ? '✅' : '❌'} | ${c.streams.map(s => `${s.health?.status ?? 'n/a'}`).join(', ')} |`);
L(`\n${sq.filter(c => c.alive).length} of ${sq.length} Albanian-language channels alive.`);

L(`\n## Alive channels per country (top 60)\n`, `| Country | Channels | Alive | % |`, `\n|---|---|---|---|`);
const byC = {};
for (const c of checked) { const k = c.country ?? '??'; byC[k] ??= { n: 0, ok: 0 }; byC[k].n++; if (c.alive) byC[k].ok++; }
Object.entries(byC).sort((a, b) => b[1].ok - a[1].ok).slice(0, 60)
  .forEach(([k, v]) => L(`| ${countries[k]?.flag ?? ''} ${countries[k]?.name ?? k} | ${v.n} | ${v.ok} | ${(100 * v.ok / v.n).toFixed(0)}% |`));

L(`\n## Alive channels per category\n`, `| Category | Alive channels |`, `\n|---|---|`);
const byCat = {};
for (const c of aliveCh) for (const k of (c.categories.length ? c.categories : ['(none)'])) byCat[k] = (byCat[k] ?? 0) + 1;
Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L(`| ${k} | ${v} |`));

await writeFile(new URL('report.md', DATA), lines.join('\n') + '\n');
await writeFile(new URL('channels.checked.json', DATA), JSON.stringify(channels));
console.log(lines.slice(0, 12).join('\n'));
console.log(`\nwrote data/report.md and data/channels.checked.json`);
