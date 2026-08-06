/**
 * Penjaga sinkronisasi daftar command panel web.
 *
 *   npx tsx scripts/check-commands.ts
 *
 * `web/app.js` sengaja menyalin daftar command supaya panel tetap berguna saat
 * API sedang mati (lihat komentar di berkasnya). Harganya: dua daftar yang bisa
 * menyimpang diam-diam — dan itu sudah pernah terjadi, /lang, /theme, dan
 * /panelapp hilang dari panel padahal ada di bot.
 *
 * Menyimpang tidak menimbulkan error apa pun saat runtime: panel hanya
 * menampilkan lebih sedikit tombol, dan tidak ada yang menyadarinya. Karena
 * itu perbandingannya dijalankan di CI, bukan diserahkan ke ingatan.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { COMMANDS, type CommandSpec } from '../api/_lib/commands';

const here = dirname(fileURLToPath(import.meta.url));
const appJsPath = join(here, '..', 'web', 'app.js');
const source = readFileSync(appJsPath, 'utf8');

const block = source.match(/const COMMANDS = \[([\s\S]*?)\n\];/);
if (!block) {
  console.error(`❌ Tidak menemukan array COMMANDS di ${appJsPath}.`);
  process.exit(1);
}

interface PanelEntry {
  name: string;
  role: string;
  section: string;
}

const panel: PanelEntry[] = [];
for (const line of block[1].split('\n')) {
  const name = line.match(/name:\s*'([^']+)'/);
  if (!name) continue;
  panel.push({
    name: name[1],
    role: line.match(/role:\s*'([^']+)'/)?.[1] ?? '',
    section: line.match(/section:\s*'([^']+)'/)?.[1] ?? '',
  });
}

const errors: string[] = [];
const byName = new Map<string, CommandSpec>(COMMANDS.map((c) => [c.name, c]));
const panelByName = new Map(panel.map((p) => [p.name, p]));

for (const spec of COMMANDS) {
  const entry = panelByName.get(spec.name);
  if (!entry) {
    errors.push(`web/app.js kekurangan /${spec.name} (ada di api/_lib/commands.ts)`);
    continue;
  }
  if (entry.role !== spec.role) {
    errors.push(`/${spec.name}: role panel '${entry.role}' ≠ server '${spec.role}'`);
  }
  if (entry.section !== spec.section) {
    errors.push(`/${spec.name}: section panel '${entry.section}' ≠ server '${spec.section}'`);
  }
}

for (const entry of panel) {
  if (!byName.has(entry.name)) {
    errors.push(`web/app.js menyebut /${entry.name} yang tidak ada di api/_lib/commands.ts`);
  }
}

if (errors.length) {
  console.error(`❌ ${errors.length} masalah sinkronisasi command:\n` + errors.map((e) => '  · ' + e).join('\n'));
  process.exit(1);
}
console.log(`✅ Daftar command panel sinkron — ${COMMANDS.length} command.`);
