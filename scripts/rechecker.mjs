// Background rechecker: keeps data/health.json fresh by running check.mjs on a schedule.
// The viewer server starts it (npm run serve / keep-serve); it also runs on its own:
//   node scripts/rechecker.mjs            # scheduler in the foreground, without the viewer
//   node scripts/rechecker.mjs albanian   # run one job now (albanian | new | full)
// Last run times survive restarts (data/rechecker.json), so a restart does not redo the daily full check.
import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA = new URL('../data/', import.meta.url);
const STATE = new URL('rechecker.json', DATA);
const LOG = new URL('rechecker.log', DATA);
const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url));
const MIN = 60_000, HOUR = 60 * MIN;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Albanian channels often go off air for hours, so they are checked often. A full run downloads ~2 GB (a 64 KB segment
// sample per stream) and does ~900 YouTube lookups, so it runs once a day. Albanian gets its own lane so it is not stuck
// behind a 40-minute full run; the other jobs take turns.
export const JOBS = {
  albanian: { every: num(process.env.RECHECK_MIN, 30) * MIN, lane: 'albanian', env: { ONLY: 'SQ', CONCURRENCY: '16' } },
  new: { every: 1 * HOUR, lane: 'bulk', env: { NEW_ONLY: '1' } },            // links a fetch/merge added that were never checked
  full: { every: num(process.env.RECHECK_FULL_H, 24) * HOUR, lane: 'bulk', env: {} },
};

export function startRechecker({ onDone = () => {}, log = console.log } = {}) {
  const state = { lastRun: {}, running: {} };
  if (process.env.RECHECK === '0') return state;
  const busy = new Set(), queue = [];
  const due = name => !state.lastRun[name] || Date.now() - Date.parse(state.lastRun[name]) >= JOBS[name].every;

  function tick() {
    for (const [name, job] of Object.entries(JOBS)) if (job.every > 0 && due(name) && !state.running[name] && !queue.includes(name)) queue.push(name);
    for (const name of [...queue]) {
      if (busy.has(JOBS[name].lane)) continue;
      queue.splice(queue.indexOf(name), 1);
      run(name).then(tick);
    }
  }

  async function run(name) {
    const job = JOBS[name];
    busy.add(job.lane); state.running[name] = new Date().toISOString();
    const { code, summary, seconds } = await runCheck(job.env);
    delete state.running[name]; busy.delete(job.lane);
    state.lastRun[name] = new Date().toISOString();
    await writeFile(STATE, JSON.stringify(state.lastRun)).catch(() => {});
    const line = `[${state.lastRun[name]}] ${name}: ${code === 0 ? summary : `failed (exit ${code})`} in ${seconds} s`;
    await appendFile(LOG, line + '\n').catch(() => {});
    log(line);
    if (code === 0) onDone(name);
  }

  readFile(STATE, 'utf8').then(s => Object.assign(state.lastRun, JSON.parse(s))).catch(() => {})
    .finally(() => { setTimeout(tick, 60_000); setInterval(tick, 5 * MIN); }); // first look a minute after start, then every 5 min
  return state;
}

// one check.mjs run; resolves with its exit code and a "143 checked, 72 ok" summary from its progress output
export function runCheck(env, { inherit = false } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let summary = 'nothing to check', tail = '';
    const child = spawn(process.execPath, [CHECK], { env: { ...process.env, ...env }, stdio: ['ignore', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'] });
    child.stdout?.on('data', d => {
      tail = (tail + d).slice(-4000);
      const m = [...tail.matchAll(/(\d+) done, (\d+) ok/g)].pop();
      if (m) summary = `${m[1]} checked, ${m[2]} ok`;
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => resolve({ code: -1, summary, seconds: 0 }));
    child.on('exit', code => resolve({ code, summary, seconds: Math.round((Date.now() - t0) / 1000) }));
  });
}

// run directly: one job now, or the scheduler on its own
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const name = process.argv[2];
  if (name) {
    if (!JOBS[name]) { console.error(`unknown job "${name}"; use one of: ${Object.keys(JOBS).join(', ')}`); process.exit(1); }
    const { code } = await runCheck(JOBS[name].env, { inherit: true });
    const lastRun = JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));
    lastRun[name] = new Date().toISOString();
    await writeFile(STATE, JSON.stringify(lastRun));
    process.exit(code ?? 1);
  }
  console.log(`rechecker running: ${Object.entries(JOBS).map(([n, j]) => `${n} every ${j.every >= HOUR ? `${j.every / HOUR} h` : `${j.every / MIN} min`}`).join(', ')} (log: data/rechecker.log)`);
  startRechecker();
}
