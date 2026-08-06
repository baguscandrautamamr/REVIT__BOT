/**
 * Penjaga format modul fungsi Vercel.
 *
 *   npx tsx scripts/check-runtime.ts
 *
 * Menjaga satu invarian yang kalau rusak akan MEMATIKAN SELURUH ENDPOINT
 * sekaligus, dengan `tsc` tetap hijau dan tanpa satu pun petunjuk di kode.
 *
 * @vercel/node tidak mem-bundle apa pun. Ia meng-compile tiap .ts memakai
 * tsconfig TERDEKAT ke entrypoint, menaruh hasilnya di samping sumbernya, lalu
 * membiarkan Node memuatnya — dan Node menentukan format dari package.json
 * TERDEKAT. Dua berkas berbeda, dua keputusan terpisah, dan keduanya harus
 * sepakat. Kalau tidak:
 *
 *   emit ESM  + "type": "commonjs" → SyntaxError: Cannot use import statement…
 *   emit CJS  + "type": "module"   → ReferenceError: exports is not defined
 *   emit ESM  + "type": "module"   → ERR_MODULE_NOT_FOUND, sebab import relatif
 *                                    di repo ini ditulis tanpa ekstensi
 *
 * Ketiganya keluar sebagai FUNCTION_INVOCATION_FAILED yang identik di browser,
 * dan satu-satunya jejaknya ada di log Vercel. Repo ini sudah dua kali kena.
 *
 * Karena itu penjaga ini tidak membaca sumber lalu menebak. Ia meng-compile
 * seluruh api/ persis seperti @vercel/node, menaruhnya di folder sementara
 * bersama api/package.json yang asli, lalu BENAR-BENAR memuat tiap endpoint.
 * Kalau produksi akan mati, perintah ini mati lebih dulu — di laptop, di CI.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'api');
const errors: string[] = [];

// ── 1. Kedua keputusan itu masih tertulis, dan masih sepakat ───────────────

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const apiPkg = readJson<{ type?: string }>(join(apiDir, 'package.json'));
// tsconfig.json boleh berisi komentar, jadi dibaca lewat TypeScript, bukan JSON.parse.
const apiTsconfig = ts.readConfigFile(join(apiDir, 'tsconfig.json'), ts.sys.readFile).config as
  | { compilerOptions?: { module?: string } }
  | undefined;

if (rootPkg.type === 'module' && apiPkg?.type !== 'commonjs') {
  errors.push(
    `api/package.json ${apiPkg ? `menyatakan "type": "${apiPkg.type}"` : 'hilang'} — seharusnya ` +
      '"commonjs". package.json root memakai "type": "module", jadi tanpa ini Node memuat ' +
      'api/**/*.js sebagai ESM native dan setiap import relatif tanpa ekstensi gagal.',
  );
}

const apiModule = apiTsconfig?.compilerOptions?.module;
if (apiModule?.toLowerCase() !== 'commonjs') {
  errors.push(
    `api/tsconfig.json ${existsSync(join(apiDir, 'tsconfig.json')) ? `menyatakan "module": "${apiModule}"` : 'hilang'} — ` +
      'seharusnya "CommonJS". tsconfig root memakai "ESNext", dan hasil compile-nya ' +
      'tidak bisa dimuat oleh api/package.json yang "commonjs".',
  );
}

// ── 2. Buktikan: compile seperti Vercel, lalu muat sungguhan ───────────────

/**
 * Pemuat yang berjalan di proses node polos. Satu baris per endpoint, TSV:
 * `OK <rel>` | `NOHANDLER <rel>` | `FAIL <rel> <pesan>`.
 */
const LOADER = `
const { join } = require('node:path');
for (const rel of process.argv.slice(2)) {
  try {
    const mod = require(join(__dirname, rel));
    const handler = mod && mod.default ? mod.default : mod;
    process.stdout.write((typeof handler === 'function' ? 'OK\\t' : 'NOHANDLER\\t') + rel + '\\n');
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err)).split('\\n')[0];
    process.stdout.write('FAIL\\t' + rel + '\\t' + msg + '\\n');
  }
}
`;

const stage = mkdtempSync(join(tmpdir(), 'vercel-runtime-'));
try {
  const sources = walk(apiDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

  for (const file of sources) {
    const out = join(stage, relative(apiDir, file)).replace(/\.ts$/, '.js');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, emit(file));
  }
  // package.json yang ASLI — inilah yang menentukan format saat dimuat.
  writeFileSync(join(stage, 'package.json'), readFileSync(join(apiDir, 'package.json')));

  const endpoints = sources
    .map((file) => relative(apiDir, file))
    .filter((rel) => !rel.split(sep).some((part) => part.startsWith('_'))) // _lib/ bukan endpoint
    .map((rel) => rel.replace(/\.ts$/, '.js'));

  writeFileSync(join(stage, '__load.cjs'), LOADER);

  // Dijalankan di proses `node` POLOS, bukan di dalam tsx. tsx memasang resolver
  // sendiri yang memaafkan import tanpa ekstensi — persis kesalahan yang sedang
  // dicari di sini. Memuat lewat tsx akan melaporkan hijau untuk kode yang mati
  // di Vercel.
  const run = spawnSync(process.execPath, [join(stage, '__load.cjs'), ...endpoints], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const line of run.stdout.split('\n').filter(Boolean)) {
    const [status, rel, ...rest] = line.split('\t');
    if (status === 'OK') continue;
    if (status === 'NOHANDLER') {
      errors.push(`api/${rel} tidak meng-export default sebuah handler — Vercel akan menolaknya.`);
    } else {
      errors.push(
        `api/${rel} GAGAL DIMUAT sebagai fungsi Vercel — di produksi ini muncul sebagai ` +
          `FUNCTION_INVOCATION_FAILED:\n      ${rest.join('\t')}`,
      );
    }
  }
  if (run.status !== 0) {
    errors.push(`Pemuat gagal dijalankan (exit ${run.status}): ${run.stderr.trim().split('\n')[0]}`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

/** Compile satu berkas persis seperti @vercel/node: tsconfig terdekat, tanpa bundling. */
function emit(file: string): string {
  const configPath = ts.findConfigFile(file, ts.sys.fileExists);
  if (!configPath) throw new Error(`tsconfig.json tidak ditemukan dari ${file}`);

  const raw = ts.readConfigFile(configPath, ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, dirname(configPath), undefined, configPath);

  return ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { ...parsed.options, noEmit: false, sourceMap: false },
  }).outputText;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (errors.length) {
  console.error(`❌ ${errors.length} masalah runtime:\n` + errors.map((e) => '  · ' + e).join('\n'));
  process.exit(1);
}
console.log('✅ Semua endpoint dimuat sebagai fungsi Vercel — api/ CommonJS, root ESM.');
