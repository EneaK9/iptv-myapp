// Minimal extended-M3U parser. Handles CRLF, #EXTINF attributes, #EXTVLCOPT headers, #EXTGRP.
export function parseM3U(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const items = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const comma = line.lastIndexOf(',');
      const head = line.slice(8, comma);
      const name = line.slice(comma + 1).trim();
      const attrs = {};
      for (const m of head.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      cur = { name, attrs, headers: {}, url: null };
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const [k, ...v] = line.slice(11).split('=');
      cur.headers[k.trim()] = v.join('=').trim();
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.attrs['group-title'] ??= line.slice(8).trim();
    } else if (line.startsWith('#')) {
      continue;
    } else if (cur) {
      cur.url = line;
      items.push(cur);
      cur = null;
    }
  }
  return items;
}
