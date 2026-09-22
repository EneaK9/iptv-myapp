// Shared status normalization for checker output.
export function classifyError(e) {
  const name = String(e?.name ?? '');
  const m = String(e?.cause?.code ?? e?.code ?? e?.message ?? e);
  if (/TimeoutError|AbortError/.test(name) || /Timeout|aborted/i.test(m)) return 'timeout';
  if (/CERT|SSL|TLS|self.signed|altname|EPROTO|LEAF_SIGNATURE/i.test(m)) return 'tls';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'dns';
  if (/ECONNREFUSED/i.test(m)) return 'refused';
  if (/EHOSTDOWN|EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'unreachable';
  if (/ECONNRESET|EPIPE|socket hang up|UND_ERR_SOCKET|other side closed/i.test(m)) return 'reset';
  if (/ERR_INVALID_URL|Invalid URL|TypeError/i.test(m + name)) return 'bad_url';
  return 'error:' + m.slice(0, 40);
}
// Re-map statuses written by older checker versions.
export function normalizeStatus(s) {
  if (s === 'error:23') return 'timeout';
  if (/^error:.*(CERT|SSL|TLS|LEAF_SIGNATURE)/i.test(s)) return 'tls';
  if (/^error:(EHOSTDOWN|EHOSTUNREACH|ENETUNREACH)/.test(s)) return 'unreachable';
  if (/^error:TypeError/.test(s)) return 'bad_url';
  return s;
}
