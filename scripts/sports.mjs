// Writes data/sports-by-country.md: alive sports channels grouped by country
import { readFile, writeFile } from 'node:fs/promises';
const DATA = new URL('../data/', import.meta.url);
const ch = JSON.parse(await readFile(new URL('channels.checked.json', DATA), 'utf8'));
const countries = Object.fromEntries(JSON.parse(await readFile(new URL('raw/iptv-org.countries.json', DATA), 'utf8')).map(c => [c.code, c]));
const sports = ch.filter(c => c.alive && !c.isNsfw && c.categories.includes('sports'));
const byC = {};
for (const c of sports) (byC[c.country ?? '??'] ??= []).push(c);
const L = [`# Alive sports channels by country`, ``, `Generated ${new Date().toISOString()}. ${sports.length} channels in ${Object.keys(byC).length} countries. "alive" = stream delivered data at last check.`, ``];
for (const [code, list] of Object.entries(byC).sort((a, b) => b[1].length - a[1].length)) {
  const c = countries[code];
  L.push(`## ${c?.flag ?? ''} ${c?.name ?? (code === '??' ? 'Unknown country' : code)} (${list.length})`, ``);
  for (const x of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const q = x.streams.find(s => s.health?.status === 'ok')?.quality ?? '';
    L.push(`- ${x.name}${q ? ` · ${q}` : ''}${x.sportsByName ? ' · (tagged by name)' : ''}`);
  }
  L.push('');
}
await writeFile(new URL('sports-by-country.md', DATA), L.join('\n'));
console.log(`wrote data/sports-by-country.md: ${sports.length} channels, ${Object.keys(byC).length} countries`);
console.log(Object.entries(byC).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k}:${v.length}`).join('  '));
