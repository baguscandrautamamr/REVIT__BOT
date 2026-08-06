/**
 * Penjaga format modul fungsi Vercel.
 *
 *   npx tsx scripts/check-runtime.ts
 *
 * Menjaga satu invarian yang kalau rusak akan MEMATIKAN SELURUH ENDPOINT
 * sekaligus, dengan `tsc` tetap hijau dan tanpa satu pun petunjuk di kode.
 *
 * Riwayatnya: package.json root memakai `"type": "module"`, dan builder
 * @vercel/node memutuskan format modul begini —
 *
 *   isEsm = ext === '.mjs' || ext === '.mts'
 *        || pkg.type === 'module' && ['.js','.ts','.tsx'].includes(ext)
 *
 * — lalu memuat entrypoint sebagai ESM native, bukan hasil bundling. Resolver
 * ESM Node mewajibkan path relatif ditulis lengkap dengan ekstensi, sementara
 * seluruh repo ini menulis `'./_lib/db'`. Hasilnya setiap endpoint menjawab
 * FUNCTION_INVOCATION_FAILED, dan satu-satunya jejaknya cuma ERR_MODULE_NOT_FOUND
 * di log Vercel.
 *
 * `pkg` diambil dari package.json TERDEKAT ke entrypoint, jadi `api/package.json`
 * berisi `"type": "commonjs"` yang membatalkannya. Dua hal yang dijaga di sini:
 *
 *   1. Berkas itu masih ada dan masih menyatakan commonjs.
 *   2. Tidak ada fitur ESM-only (top-level await, import.meta) yang menyelinap
 *      masuk ke api/ — keduanya butuh ESM dan akan gagal saat dimuat sebagai CJS.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors: string[] = [];

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (rootPkg.type === 'module') {
  let apiPkg: { type?: string } | null = null;
  try {
    apiPkg = JSON.parse(readFileSync(join(root, 'api', 'package.json'), 'utf8'));
  } catch {
    apiPkg = null;
  }

  if (!apiPkg) {
    errors.push(
      'api/package.json hilang. package.json root memakai "type": "module", jadi ' +
        '@vercel/node akan memuat api/**/*.ts sebagai ESM native — dan SEMUA endpoint ' +
        'mati dengan ERR_MODULE_NOT_FOUND karena import relatif di repo ini tidak ' +
        'memakai ekstensi. Kembalikan berkas itu dengan isi { "type": "commonjs" }.',
    );
  } else if (apiPkg.type !== 'commonjs') {
    errors.push(
      `api/package.json menyatakan "type": "${apiPkg.type}", seharusnya "commonjs". ` +
        'Lihat komentar di dalam berkas itu sebelum mengubahnya.',
    );
  }
}

// Fitur ESM-only di dalam api/ — akan meledak saat dimuat sebagai CommonJS.
for (const file of walk(join(root, 'api'))) {
  if (!file.endsWith('.ts')) continue;
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');

  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;

    if (/\bimport\.meta\b/.test(line)) {
      errors.push(`${rel}:${i + 1} memakai import.meta — tidak ada di CommonJS.`);
    }
    // Top-level await: `await` di kolom 0, atau deklarasi di kolom 0 yang menunggu.
    if (/^await\s/.test(line) || /^(?:const|let|var)\s[^=]+=\s*await\s/.test(line)) {
      errors.push(`${rel}:${i + 1} memakai top-level await — butuh ESM.`);
    }
  });
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
console.log('✅ Format modul fungsi Vercel benar — api/ CommonJS, root ESM.');
