// Builds the Samsung TV app: build/tv/ -> signed build/IPTV.wgt, using Samsung's Tizen CLI in Docker
// (it does not run natively on Apple Silicon). With a TV address it also installs it:
//   node scripts/tv-package.mjs                 # build + sign
//   node scripts/tv-package.mjs 192.168.0.50    # build + sign + install on the TV (Developer Mode on, Host PC IP = this Mac)
// The author certificate lives in ~/.iptv-myapp-tizen/ and must stay the same, or the TV refuses updates over the old app.
import { mkdir, rm, cp, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = `${ROOT}build`, APP = `${BUILD}/tv`, CERTS = `${homedir()}/.iptv-myapp-tizen`;
const IMAGE = 'vitalets/tizen-webos-sdk:3.0';
const PASSWORD = 'iptvmyapp'; // protects only the local author certificate
const tvIp = process.argv[2];

// app icon (512x423, what Samsung's launcher uses): dark tile, red rounded square, white play triangle
function icon(w = 512, h = 423) {
  const px = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    px[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c = [11, 15, 22];
      const cx = x - w / 2, cy = y - h / 2, r = 36, half = 140;
      const dx = Math.max(Math.abs(cx) - (half - r), 0), dy = Math.max(Math.abs(cy) - (half - r), 0);
      if (dx * dx + dy * dy <= r * r) c = [220, 38, 38];
      if (cx >= -45 && cx <= 70 && Math.abs(cy) <= (70 - cx) * (60 / 115)) c = [255, 255, 255]; // triangle (-45,±60) -> (70,0)
      const o = y * (w * 4 + 1) + 1 + x * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

await rm(BUILD, { recursive: true, force: true });
await mkdir(APP, { recursive: true });
await mkdir(CERTS, { recursive: true });
for (const f of ['index.html', 'style.css', 'app.js', 'config.xml']) await cp(`${ROOT}tv/${f}`, `${APP}/${f}`);
await cp(`${ROOT}data/tv.json`, `${APP}/tv.json`); // offline copy; the app downloads the fresh list from GitHub first
await writeFile(`${APP}/icon.png`, icon());

const haveCert = await access(`${CERTS}/author.p12`).then(() => true, () => false);
const steps = [
  'set -e',
  haveCert ? 'echo "author certificate: existing"' : `tizen certificate -a iptvmyapp -p ${PASSWORD} -c AL -n "IPTV myapp" -f author -- /certs`,
  `tizen security-profiles add -n iptv -a /certs/author.p12 -p ${PASSWORD} > /dev/null 2>&1`,
  // headless CLI never writes the .pwd files profiles.xml points to ("Invaild password"): put the passwords in directly
  // (tizenpkcs12passfordsigner is the published password of Samsung's public distributor certificate)
  `sed -i 's|password="/certs/author.pwd"|password="${PASSWORD}"|; s|password="[^"]*tizen-distributor-signer.pwd"|password="tizenpkcs12passfordsigner"|g' ~/tizen-studio-data/profile/profiles.xml`,
  'tizen cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml" > /dev/null',
  'cp -r /build/tv /tmp/app && cd /tmp/app && tizen package -t wgt -s iptv -- /tmp/app > /tmp/pkg.log 2>&1 || (cat /tmp/pkg.log; tail -5 ~/tizen-studio-data/cli/logs/cli.log; exit 1)',
  'cp /tmp/app/*.wgt /build/IPTV.wgt && echo "signed: build/IPTV.wgt"',
];
if (tvIp) steps.push(
  `sdb connect ${tvIp}:26101`,
  'sleep 2; sdb devices',
  `DEV=$(sdb devices | awk 'NR>1 && $1 ~ /${tvIp.replace(/\./g, '\\.')}/ {print $3}'); [ -n "$DEV" ] || DEV=$(sdb devices | awk 'NR>1 && NF {print $3; exit}')`,
  'tizen install -n IPTV.wgt -t "$DEV" -- /build',
  'echo "installed on the TV: open Apps and look for IPTV"',
);
console.log(`building with ${IMAGE}${tvIp ? `, installing on ${tvIp}` : ''} ...`);
execFileSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '-v', `${BUILD}:/build`, '-v', `${CERTS}:/certs`, IMAGE, 'bash', '-lc', steps.join('\n')], { stdio: 'inherit' });
