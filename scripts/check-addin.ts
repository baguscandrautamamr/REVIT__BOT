/**
 * Penjaga sumber add-in yang bisa jalan TANPA .NET SDK.
 *
 *   npx tsx scripts/check-addin.ts
 *
 * KENAPA ADA: satu-satunya yang benar-benar meng-compile C# di proyek ini adalah
 * workflow `addin` di GitHub Actions. Di laptop tanpa Revit — dan di lingkungan
 * mana pun yang tidak bisa menjangkau NuGet — tidak ada apa pun yang membaca
 * berkas `.cs` sebelum ia dipush. Akibatnya kesalahan paling sepele pun baru
 * ketahuan setelah satu putaran penuh: push, tunggu runner, baca log.
 *
 * Tiga kesalahan berikut benar-benar lolos ke CI dengan cara persis begitu, dan
 * ketiganya bisa dilihat dari teksnya saja:
 *
 *   1. `}` penutup kelas hilang        → CS1513
 *   2. satu byte NUL menyelinap ke     → berkas terbaca "biner" oleh perkakas
 *      dalam string                       lain, dan isinya diam-diam salah
 *   3. `StringBuilder` dipakai tanpa   → CS0246; `ImplicitUsings` .NET TIDAK
 *      `using System.Text;`               memuat System.Text
 *
 * INI BUKAN COMPILER. Ia tidak mengerti tipe, tidak memeriksa tanda tangan
 * metode, dan tidak tahu apa pun tentang Revit API. Lolos di sini TIDAK berarti
 * kodenya compile — yang menentukan tetap workflow `addin`. Yang dikerjakan
 * berkas ini cuma satu: memindahkan tiga kesalahan yang paling murah dideteksi
 * dari "ketahuan lima menit kemudian di CI" menjadi "ketahuan sekarang".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const addinDir = join(root, 'addin');
const errors: string[] = [];

/**
 * Namespace yang TIDAK ikut `ImplicitUsings`, beserta tipe yang menandainya.
 *
 * Daftar implisit untuk proyek non-web hanya: System, System.Collections.Generic,
 * System.IO, System.Linq, System.Net.Http, System.Threading,
 * System.Threading.Tasks. Selain itu harus ditulis sendiri — dan yang paling
 * sering terlupa adalah System.Text, karena `StringBuilder` terasa seperti
 * bagian dari bahasa.
 */
const REQUIRED_USINGS: Array<{ ns: string; types: string[] }> = [
  { ns: 'System.Text', types: ['StringBuilder', 'Encoding'] },
  {
    ns: 'System.Text.Json',
    types: ['JsonElement', 'JsonSerializer', 'JsonSerializerOptions', 'JsonValueKind', 'JsonNamingPolicy'],
  },
  { ns: 'System.IO.Compression', types: ['ZipFile', 'ZipArchive', 'ZipArchiveMode'] },
  { ns: 'System.Collections.Concurrent', types: ['ConcurrentQueue', 'ConcurrentDictionary', 'ConcurrentBag'] },
  { ns: 'System.Diagnostics', types: ['Stopwatch'] },
  { ns: 'System.Reflection', types: ['AssemblyInformationalVersionAttribute'] },
  { ns: 'System.Net.Http.Headers', types: ['MediaTypeHeaderValue', 'AuthenticationHeaderValue'] },
  { ns: 'System.Security.Cryptography', types: ['ProtectedData', 'DataProtectionScope'] },
];

for (const file of csFiles(addinDir)) {
  const shown = relative(root, file);
  const raw = readFileSync(file);

  // ── 1. Byte NUL ─────────────────────────────────────────────────────────
  const nul = raw.indexOf(0);
  if (nul !== -1) {
    errors.push(
      `${shown}: ada byte NUL di offset ${nul}. Berkas sumber tidak boleh memuatnya — ` +
        'perkakas lain akan memperlakukannya sebagai biner, dan isinya diam-diam bukan yang kamu tulis.',
    );
  }

  const text = raw.toString('utf8');
  const code = stripCommentsAndStrings(text);

  // ── 2. Kurung kurawal berimbang ────────────────────────────────────────
  const open = count(code, '{');
  const close = count(code, '}');
  if (open !== close) {
    errors.push(
      `${shown}: kurung kurawal tidak berimbang — ${open} '{' vs ${close} '}'. ` +
        'Paling sering: penutup kelas ikut terhapus saat menambah metode di ujung berkas.',
    );
  }

  // ── 3. using yang hilang ───────────────────────────────────────────────
  for (const { ns, types } of REQUIRED_USINGS) {
    if (hasUsing(text, ns)) continue;
    for (const type of types) {
      // `(?<![.\w])` supaya `System.Text.StringBuilder` yang sudah ditulis
      // lengkap tidak ikut dilaporkan.
      if (new RegExp(`(?<![.\\w])${type}\\b`).test(code)) {
        errors.push(`${shown}: memakai \`${type}\` tapi tidak ada \`using ${ns};\` (CS0246).`);
        break;
      }
    }
  }
}

if (errors.length) {
  console.error(`❌ ${errors.length} masalah di sumber add-in:\n` + errors.map((e) => '  · ' + e).join('\n'));
  process.exit(1);
}
console.log(`✅ Sumber add-in lolos pemeriksaan teks — ${csFiles(addinDir).length} berkas .cs.`);

/* ── Utilitas ─────────────────────────────────────────────────────────────── */

function csFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'bin' || name === 'obj') continue;
      out.push(...csFiles(full));
    } else if (name.endsWith('.cs')) {
      out.push(full);
    }
  }
  return out;
}

function hasUsing(text: string, ns: string): boolean {
  return new RegExp(`^\\s*(global\\s+)?using\\s+${ns.replace(/\./g, '\\.')}\\s*;`, 'm').test(text);
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Buang komentar dan isi string sebelum menghitung apa pun.
 *
 * Tanpa ini, satu contoh `{` di dalam komentar penjelasan sudah cukup untuk
 * melaporkan kurung tidak berimbang pada berkas yang sebenarnya benar — dan
 * penjaga yang berteriak untuk kode yang benar akan dimatikan orang, bukan
 * diperbaiki. Isinya diganti spasi, bukan dihapus, supaya offset tidak bergeser.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
      i += 2;
      continue;
    }
    // String verbatim: @"…" — di dalamnya "" berarti satu kutip.
    if (two === '@"') {
      out += '  ';
      i += 2;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') { out += '  '; i += 2; continue; }
        if (src[i] === '"') { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    // String biasa dan string interpolasi. Isi `{…}` di dalam interpolasi ikut
    // dibuang — itu berarti kode di dalamnya tidak diperiksa, dan itu memang
    // pilihan: menghitung kurungnya dengan benar butuh parser sungguhan, dan
    // penjaga yang setengah benar lebih buruk daripada penjaga yang jujur soal
    // batasnya.
    if (src[i] === '"') {
      out += ' ';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    if (src[i] === "'") {
      out += ' ';
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }

    out += src[i];
    i++;
  }

  return out;
}
