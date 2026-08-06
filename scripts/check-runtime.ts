/**
 * Penjaga format modul fungsi Vercel.
 *
 *   npx tsx scripts/check-runtime.ts
 *
 * Menjaga satu invarian yang kalau rusak MEMATIKAN SELURUH ENDPOINT sekaligus,
 * dengan `tsc` tetap hijau dan tanpa satu pun petunjuk di kode. Dari luar
 * gejalanya cuma FUNCTION_INVOCATION_FAILED, sama persis untuk semua sebab.
 *
 * Ada DUA setelan yang harus sepakat, dan keduanya diwarisi dari root:
 *
 *   package.json  "type"    → bagaimana Node MENAFSIRKAN berkas hasil build
 *   tsconfig.json "module"  → syntax apa yang DIHASILKAN transpile
 *
 * Kalau keduanya tidak cocok, hanya ada dua kemungkinan dan dua-duanya mati:
 *
 *   type: module   + syntax ESM → ESM, tapi import relatif tanpa ekstensi
 *                                 → ERR_MODULE_NOT_FOUND
 *   type: commonjs + syntax ESM → CJS, tapi berkasnya berisi `import`
 *                                 → SyntaxError: Cannot use import statement
 *
 * Builder @vercel/node mencari package.json maupun tsconfig.json dengan
 * walkParentDirs mulai dari folder entrypoint, jadi `api/package.json` dan
 * `api/tsconfig.json` yang menang atas yang di root.
 *
 * Penjaga ini sengaja memeriksa KECOCOKAN, bukan satu jawaban tertentu: setelan
 * penuh-ESM juga sah, asal setiap import relatif ditulis lengkap dengan
 * ekstensi. Itu ikut diperiksa di bawah.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors: string[] = [];

/** JSON dengan komentar `//` sebagai array — dipakai kedua berkas config di api/. */
function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const rootPkg = readJson(join(root, 'package.json')) ?? {};
const apiPkg = readJson(join(root, 'api', 'package.json'));
const rootTs = readJson(join(root, 'tsconfig.json')) ?? {};
const apiTs = readJson(join(root, 'api', 'tsconfig.json'));

// Yang benar-benar berlaku untuk api/**: yang terdekat menang.
const interpretedAs: string = apiPkg?.type ?? rootPkg.type ?? 'commonjs';
const emittedModule: string = String(
  apiTs?.compilerOptions?.module ?? rootTs.compilerOptions?.module ?? 'commonjs',
).toLowerCase();

const emitsEsm = emittedModule !== 'commonjs' && emittedModule !== 'node16cjs';

if (interpretedAs === 'commonjs' && emitsEsm) {
  errors.push(
    `api/ ditafsirkan CommonJS (package.json "type": "${interpretedAs}") tapi transpile ` +
      `menghasilkan ESM (tsconfig "module": "${emittedModule}"). Setiap fungsi akan mati ` +
      'dengan SyntaxError: Cannot use import statement outside a module. Samakan keduanya — ' +
      'lihat komentar di api/tsconfig.json.',
  );
}

if (interpretedAs === 'module' && !emitsEsm) {
  errors.push(
    `api/ ditafsirkan ESM (package.json "type": "module") tapi transpile menghasilkan ` +
      `CommonJS (tsconfig "module": "${emittedModule}"). Samakan keduanya.`,
  );
}

const apiFiles = walk(join(root, 'api')).filter((f) => f.endsWith('.ts'));

if (interpretedAs === 'module' && emitsEsm) {
  // Setelan penuh-ESM itu sah, TAPI resolver ESM Node mewajibkan path relatif
  // ditulis lengkap dengan ekstensi. Tanpa itu semua fungsi mati dengan
  // ERR_MODULE_NOT_FOUND — dan `tsc` tidak akan mengeluh sedikit pun karena
  // moduleResolution "Bundler" memang mengizinkannya.
  for (const file of apiFiles) {
    const rel = relative(root, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/^\s*(?:import|export)[^'"]*from\s+['"](\.[^'"]*)['"]/);
      if (m && !/\.(js|mjs|cjs|json)$/.test(m[1])) {
        errors.push(`${rel}:${i + 1} import relatif '${m[1]}' tanpa ekstensi — ESM Node menolaknya.`);
      }
    });
  }
}

if (interpretedAs === 'commonjs') {
  // Fitur ESM-only yang menyelinap masuk akan meledak saat dimuat sebagai CJS.
  for (const file of apiFiles) {
    const rel = relative(root, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

      if (/\bimport\.meta\b/.test(line)) {
        errors.push(`${rel}:${i + 1} memakai import.meta — tidak ada di CommonJS.`);
      }
      if (/^await\s/.test(line) || /^(?:const|let|var)\s[^=]+=\s*await\s/.test(line)) {
        errors.push(`${rel}:${i + 1} memakai top-level await — butuh ESM.`);
      }
    });
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
console.log(
  `✅ Format modul fungsi Vercel cocok — api/ ditafsirkan ${interpretedAs}, ` +
    `transpile menghasilkan ${emittedModule}.`,
);
