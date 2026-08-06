/**
 * Penjaga konsistensi katalog: jalankan di CI / sebelum deploy.
 *
 *   npx tsx scripts/check-i18n.ts
 *
 * Memeriksa tiga hal yang paling sering rusak diam-diam:
 *   1. Key yang ada di satu bahasa tapi hilang di bahasa lain
 *   2. Placeholder `{x}` yang tidak sama antar bahasa (mis. `{n}` hilang di EN)
 *   3. Deskripsi command melanggar batas Telegram (3–256 karakter)
 *
 * Kenapa penting: key yang hilang tidak error saat runtime — `t()` diam-diam
 * fallback ke Indonesia, dan user EN melihat campuran dua bahasa.
 */
import { COMMANDS } from '../api/_lib/commands';
import { LOCALES, catalog, type Locale } from '../api/_lib/i18n';

type Flat = Map<string, { placeholders: Set<string>; kind: 'string' | 'fn' }>;

function flatten(obj: unknown, prefix = '', out: Flat = new Map()): Flat {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out.set(key, { placeholders: placeholdersOf(v), kind: 'string' });
    } else if (typeof v === 'function') {
      out.set(key, { placeholders: placeholdersOf(String(v)), kind: 'fn' });
    } else if (v && typeof v === 'object') {
      flatten(v, key, out);
    }
  }
  return out;
}

/** Tangkap `{name}` (template string) dan `${p.name}` (bentuk fungsi). */
function placeholdersOf(s: string): Set<string> {
  const set = new Set<string>();
  for (const m of s.matchAll(/\{(\w+)\}/g)) set.add(m[1]);
  for (const m of s.matchAll(/\$\{\s*p\.(\w+)\s*\}/g)) set.add(m[1]);
  return set;
}

const errors: string[] = [];
const flats = new Map<Locale, Flat>(LOCALES.map((l) => [l, flatten(catalog(l))]));
const base = LOCALES[0];
const baseFlat = flats.get(base)!;

for (const locale of LOCALES) {
  if (locale === base) continue;
  const other = flats.get(locale)!;

  for (const key of baseFlat.keys()) {
    if (!other.has(key)) errors.push(`[${locale}] key hilang: ${key}`);
  }
  for (const key of other.keys()) {
    if (!baseFlat.has(key)) errors.push(`[${base}] key hilang: ${key}`);
  }
  for (const [key, meta] of baseFlat) {
    const o = other.get(key);
    if (!o) continue;
    for (const p of meta.placeholders) {
      if (!o.placeholders.has(p)) errors.push(`[${locale}] ${key}: placeholder {${p}} hilang`);
    }
    for (const p of o.placeholders) {
      if (!meta.placeholders.has(p)) errors.push(`[${base}] ${key}: placeholder {${p}} hilang`);
    }
  }
}

// Batas Telegram: nama command 1–32 char [a-z0-9_], deskripsi 3–256 char.
for (const locale of LOCALES) {
  const desc = catalog(locale).commandDesc;
  for (const c of COMMANDS) {
    if (!/^[a-z0-9_]{1,32}$/.test(c.name)) errors.push(`nama command tidak valid untuk Telegram: /${c.name}`);
    const d = desc[c.name];
    if (!d) { errors.push(`[${locale}] deskripsi command hilang: /${c.name}`); continue; }
    if (d.length < 3 || d.length > 256) errors.push(`[${locale}] deskripsi /${c.name} panjangnya ${d.length} (harus 3–256)`);
  }
}

if (errors.length) {
  console.error(`❌ ${errors.length} masalah i18n:\n` + errors.map((e) => '  · ' + e).join('\n'));
  process.exit(1);
}
console.log(`✅ i18n konsisten — ${baseFlat.size} key × ${LOCALES.length} bahasa.`);
