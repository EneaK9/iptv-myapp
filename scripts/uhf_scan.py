#!/usr/bin/env python3
"""Find digital-TV (DVB-T/T2) multiplexes on the air with a USB SDR, and help aim the antenna.

A Mac has no receiver for 470-790 MHz, so this needs an RTL-SDR stick (`brew install librtlsdr`)
or a HackRF (`brew install hackrf`). It measures power across every 8 MHz UHF channel, flags the
flat ~7.6 MHz blocks that DVB-T2 transmissions look like, and prints the frequencies to enter in a
TV's manual tuning or a DVB-T2 tuner scan. It does not decode video; that needs a DVB-T2 tuner.

  python3 scripts/uhf_scan.py scan                    # sweep 470-790 MHz (UHF 21-60), ~40 s
  python3 scripts/uhf_scan.py scan --to 694           # only UHF 21-48 (where the 700 MHz band is cleared)
  python3 scripts/uhf_scan.py scan --csv sweep.csv    # analyse an existing rtl_power / hackrf_sweep CSV
  python3 scripts/uhf_scan.py scan --dvbv5 tirana.conf --json scan.json
  python3 scripts/uhf_scan.py watch 32                # live signal meter on UHF 32 for aiming the antenna
"""
import argparse, csv, json, shutil, statistics, subprocess, sys, tempfile, time
from pathlib import Path

LABELS = Path(__file__).resolve().parent.parent / 'sources' / 'al-dvbt2-muxes.json'  # optional {"<uhf>": "label"}


def uhf_center(ch):
    return 306 + 8 * ch  # MHz; ITU Region 1 8 MHz raster, UHF 21 = 474 MHz


def mhz_to_uhf(mhz):
    return round((mhz - 306) / 8)


def sweep_cmd(lo, hi, seconds, gain, out):
    if shutil.which('rtl_power'):
        cmd = ['rtl_power', '-f', f'{lo}M:{hi}M:125k', '-i', str(max(1, seconds // 6)), '-e', f'{seconds}s', '-c', '20%']
        return cmd + (['-g', str(gain)] if gain is not None else []) + [out]
    if shutil.which('hackrf_sweep'):
        cmd = ['hackrf_sweep', '-f', f'{lo}:{hi}', '-w', '125000', '-N', str(max(5, seconds * 5)), '-r', out]
        return cmd + (['-l', '32', '-g', str(gain)] if gain is not None else [])
    sys.exit('No SDR tool found. Plug in an RTL-SDR and run `brew install librtlsdr` (or `brew install hackrf` for a HackRF).')


def run_sweep(lo, hi, seconds, gain):
    out = tempfile.NamedTemporaryFile(suffix='.csv', delete=False).name
    cmd = sweep_cmd(lo, hi, seconds, gain, out)
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0 and not Path(out).stat().st_size:
        sys.exit(f'{cmd[0]} failed:\n{r.stderr.strip()[-600:]}')
    return out


def read_sweep(path):
    """rtl_power and hackrf_sweep share a CSV layout: date, time, Hz low, Hz high, Hz step, samples, dB..."""
    bins = {}
    with open(path, newline='') as f:
        for row in csv.reader(f):
            if len(row) < 7:
                continue
            try:
                lo, step = float(row[2]), float(row[4])
                vals = [float(x) for x in row[6:] if x.strip() and 'nan' not in x]
            except ValueError:
                continue
            for i, db in enumerate(vals):
                bins.setdefault(round(lo + (i + 0.5) * step), []).append(db)
    if not bins:
        sys.exit(f'{path}: no sweep data')
    return {fr: statistics.fmean(v) for fr, v in bins.items()}


def measure(spec, ch):
    c = uhf_center(ch) * 1e6
    inner = sorted(db for fr, db in spec.items() if abs(fr - c) <= 3.2e6)  # DVB-T2 occupies ~7.6 MHz
    if len(inner) < 8:
        return None
    return {'uhf': ch, 'mhz': uhf_center(ch), 'level': statistics.median(inner),
            'ripple': inner[int(len(inner) * 0.9)] - inner[int(len(inner) * 0.1)]}


def analyse(spec, ch_from, ch_to, threshold, flat_db):
    chans = [m for ch in range(ch_from, ch_to + 1) if (m := measure(spec, ch))]
    if not chans:
        sys.exit('sweep has no data in the requested channel range')
    levels = sorted(c['level'] for c in chans)
    floor = levels[max(0, int(len(levels) * 0.2) - 1)]  # quietest fifth of the band
    for c in chans:
        c['above_floor'] = round(c['level'] - floor, 1)
        c['mux'] = c['above_floor'] >= threshold and c['ripple'] <= flat_db
    return floor, chans


def load_labels():
    try:
        return json.loads(LABELS.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def cmd_scan(a):
    ch_from, ch_to = mhz_to_uhf(a.frm + 4), mhz_to_uhf(a.to - 4)
    path = a.csv or run_sweep(a.frm, a.to, a.seconds, a.gain)
    floor, chans = analyse(read_sweep(path), ch_from, ch_to, a.threshold, a.flat)
    labels = load_labels()
    print(f'noise floor {floor:.1f} dB   (a multiplex = at least {a.threshold} dB above it and flat across the channel)\n')
    print(' UHF    MHz   above floor')
    for c in chans:
        bar = '#' * max(0, min(40, int(c['above_floor'])))
        tag = f"  DVB-T2 multiplex  {labels.get(str(c['uhf']), '')}" if c['mux'] else ''
        print(f" {c['uhf']:>3}  {c['mhz']:>5.0f}  {c['above_floor']:+6.1f} dB  {bar:<40}{tag}")
    found = [c for c in chans if c['mux']]
    print(f"\n{len(found)} multiplexes: " + ', '.join(f"UHF {c['uhf']} ({c['mhz']} MHz)" for c in found))
    if found:
        print('TV manual tuning: enter these frequencies with bandwidth 8 MHz.')
    if a.json:
        Path(a.json).write_text(json.dumps({'floor_db': floor, 'channels': chans}, indent=1))
        print(f'wrote {a.json}')
    if a.dvbv5:
        Path(a.dvbv5).write_text(''.join(f"[UHF{c['uhf']}]\n\tDELIVERY_SYSTEM = DVBT2\n\tFREQUENCY = {c['mhz'] * 1_000_000}\n\tBANDWIDTH_HZ = 8000000\n\n" for c in found))
        print(f'wrote {a.dvbv5}  (use with: dvbv5-scan {a.dvbv5})')


def cmd_watch(a):
    mhz = uhf_center(a.uhf)
    ref = None
    best = None
    print(f'UHF {a.uhf} ({mhz} MHz): turn the antenna slowly and stop where the level peaks. Ctrl-C to stop.')
    try:
        while True:
            spec = read_sweep(run_sweep(mhz - 12, mhz + 12, a.seconds, a.gain))
            m = measure(spec, a.uhf)
            side = [x['level'] for ch in (a.uhf - 1, a.uhf + 1) if (x := measure(spec, ch))]
            if not m:
                continue
            ref = min(side) if side else (ref if ref is not None else m['level'])
            rel = m['level'] - ref
            best = rel if best is None else max(best, rel)
            print(f"\r{time.strftime('%H:%M:%S')}  {rel:+5.1f} dB  {'#' * max(0, min(40, int(rel))):<40} best {best:+.1f} dB ", end='', flush=True)
    except KeyboardInterrupt:
        print()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('scan', help='sweep the UHF band and list DVB-T2 multiplexes')
    s.add_argument('--from', dest='frm', type=int, default=470, help='MHz (default 470)')
    s.add_argument('--to', type=int, default=790, help='MHz (default 790 = top of UHF 60; Albanian muxes still use UHF 49-60)')
    s.add_argument('--seconds', type=int, default=40, help='sweep duration; longer averages out noise')
    s.add_argument('--gain', type=float, help='tuner gain in dB (default: automatic)')
    s.add_argument('--threshold', type=float, default=6, help='dB above noise floor to count as a multiplex')
    s.add_argument('--flat', type=float, default=8, help='max dB ripple across the channel for a multiplex')
    s.add_argument('--csv', help='analyse an existing rtl_power / hackrf_sweep CSV instead of sweeping')
    s.add_argument('--json', help='write results as JSON')
    s.add_argument('--dvbv5', help='write a dvbv5-scan initial-tuning file for the multiplexes found')
    w = sub.add_parser('watch', help='live signal meter on one UHF channel, for aiming the antenna')
    w.add_argument('uhf', type=int)
    w.add_argument('--seconds', type=int, default=2)
    w.add_argument('--gain', type=float)
    a = p.parse_args()
    cmd_scan(a) if a.cmd == 'scan' else cmd_watch(a)


if __name__ == '__main__':
    main()
