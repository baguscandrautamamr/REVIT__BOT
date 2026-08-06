/**
 * Penyusun teks balasan yang dibuat SERVER (bukan hasil dari Revit).
 * Semua keluaran di sini sudah aman untuk `parse_mode: 'MarkdownV2'`.
 */
import { COMMANDS, notImplemented, type Section } from './commands';
import { code, codeBlocks, mdv2 } from './telegram';
import { translator, type Locale } from './i18n';
import { UTC_OFFSET_MINUTES, isOnline } from './limits';
import type { BotUser, CommandRow, MachineState, Role } from './db';

const SECTION_KEY: Record<Section, string> = {
  info: 'help.sectionInfo',
  query: 'help.sectionQuery',
  export: 'help.sectionExport',
  modify: 'help.sectionModify',
  admin: 'help.sectionAdmin',
};

const SECTION_ORDER: Section[] = ['info', 'query', 'export', 'modify', 'admin'];

export function helpText(locale: Locale, role: Role): string {
  const t = translator(locale);
  const out: string[] = [`*${mdv2(t('help.title'))}*`, ''];

  let hidden = 0;
  let soon = 0;
  for (const section of SECTION_ORDER) {
    const items = COMMANDS.filter((c) => c.section === section);
    const visible = items.filter((c) => role === 'admin' || c.role === 'viewer');
    hidden += items.length - visible.length;
    if (!visible.length) continue;

    out.push(`*${mdv2(t(SECTION_KEY[section]))}*`);
    for (const c of visible) {
      const usage = c.usage?.[locale];
      const line = usage ? usage : `/${c.name}`;
      // Command yang add-in-nya belum ada tetap didaftar — orang perlu tahu
      // rencananya — tapi ditandai. Mendaftarnya tanpa tanda apa pun adalah
      // janji yang pasti dilanggar begitu ada yang mengetiknya.
      const mark = notImplemented(c) ? ` ${t('help.soon')}` : '';
      if (mark) soon++;
      out.push(`${mdv2(line)} — ${mdv2(t(`commandDesc.${c.name}`) + mark)}`);
    }
    out.push('');
  }

  out.push(mdv2(t('help.roleNote', { role })));
  if (hidden) out.push(mdv2(t('help.hiddenNote', { n: hidden })));
  if (soon) out.push(mdv2(t('help.soonNote', { n: soon })));
  out.push('', mdv2(t('help.footer')));
  return out.join('\n');
}

export function statusText(
  locale: Locale,
  machine: MachineState,
  queue: { pending: CommandRow[]; running: CommandRow[] },
): string {
  const t = translator(locale);
  const online = isOnline(machine.last_seen_at);
  const lines: string[] = [`*${mdv2(t('status.title'))}*`, ''];

  lines.push(
    mdv2(
      online
        ? t('status.online', { ago: relativeTime(machine.last_seen_at, locale) })
        : t('status.offline', {
            since: machine.last_seen_at ? absoluteTime(machine.last_seen_at, locale) : '—',
          }),
    ),
  );

  lines.push(
    mdv2(machine.active_doc ? t('status.model', { title: machine.active_doc }) : t('status.noModel')),
  );
  lines.push(
    mdv2(
      t('status.revit', {
        version: machine.revit_version ?? '—',
        addin: machine.addin_version ?? '—',
      }),
    ),
  );
  lines.push(
    mdv2(t('status.queue', { pending: queue.pending.length, running: queue.running.length })),
  );
  if (machine.is_paused) lines.push(mdv2(t('status.paused')));

  return lines.join('\n');
}

export function queueText(locale: Locale, chatId: number, queue: {
  pending: CommandRow[];
  running: CommandRow[];
}): string {
  const t = translator(locale);
  const all = [...queue.running, ...queue.pending];
  if (!all.length) return mdv2(t('common.empty'));

  const rows = all.map((job, i) => {
    const mine = job.chat_id === chatId ? '›' : ' ';
    const mark = job.status === 'running' ? '▶' : '·';
    return `${mine} ${mark} ${String(i + 1).padStart(2)}  /${job.command.padEnd(9)} ${job.id.slice(0, 8)}`;
  });

  const mineIndex = all.findIndex((j) => j.chat_id === chatId);
  const head = mineIndex >= 0 ? t('common.position', { pos: mineIndex + 1, total: all.length }) : '';
  return (head ? mdv2(head) + '\n' : '') + code(rows.join('\n'));
}

export function usersText(locale: Locale, users: BotUser[]): string {
  const t = translator(locale);
  const rows = users.map((u) =>
    t('admin.userRow', {
      name: u.name,
      role: u.role,
      status: u.is_active ? 'aktif' : 'nonaktif',
    }),
  );
  return `*${mdv2(t('admin.usersTitle'))}*\n` + code(rows.join('\n'));
}

/**
 * Hasil dari add-in: teks bebas → satu atau lebih blok kode.
 *
 * Tabel angka lebih terbaca monospace, dan blok kode menghindari seluruh
 * masalah escaping MarkdownV2 untuk teks yang datang dari Revit.
 *
 * Mengembalikan ARRAY, bukan satu string: hasil Revit tidak punya batas atas
 * yang bisa dipercaya, dan satu pesan yang melewati 4096 karakter ditolak
 * Telegram seutuhnya. Pemanggil wajib mengirim semua bagiannya.
 */
export function resultBlocks(result: Record<string, unknown> | null): string[] {
  const text = typeof result?.text === 'string' ? result.text : '';
  return codeBlocks(text);
}

/**
 * Lama eksekusi di dalam Revit, dalam kalimat.
 *
 * Ditampilkan supaya "kenapa lama?" punya jawaban berupa angka. Tanpa ini
 * export yang memang berat dan job yang tersangkut sama-sama terlihat sebagai
 * "⏳" yang tidak kunjung berubah.
 */
export function durationText(ms: number, locale: Locale): string {
  const t = translator(locale);
  const seconds = Math.round(ms / 1000);
  return seconds < 90
    ? t('common.seconds', { n: seconds })
    : t('common.minutes', { n: Math.round(seconds / 60) });
}

/** "3 menit lalu". `null` → em dash, supaya pemanggil tidak perlu menjaga itu. */
export function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return '—';
  const diffSec = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(diffSec, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  return rtf.format(Math.round(diffSec / 86400), 'day');
}

/**
 * Tanggal + jam dalam WAKTU KANTOR, bukan waktu server.
 *
 * Fungsi Vercel berjalan di UTC, dan `Intl.DateTimeFormat` tanpa `timeZone`
 * memakai zona waktu proses — jadi jam yang tercetak tujuh jam lebih awal dari
 * jam di dinding. Akibatnya satu kalimat menyebut dua waktu yang saling
 * bertentangan:
 *
 *   🔴 PC offline sejak 6 Agu 2026, 06.47 (2 menit lalu).
 *
 * Yang salah justru angka mutlaknya — dan angka itulah yang dipakai orang untuk
 * menyimpulkan "berarti sudah mati sejak sebelum saya datang", keliru tujuh jam,
 * untuk PC yang baru saja terlihat. Kegagalan yang tidak terlihat sebagai
 * kegagalan: tidak ada error, cuma angka yang meyakinkan dan salah.
 *
 * Offsetnya sama dengan yang sudah dipakai `startOfLocalDay` untuk hitungan
 * "selesai hari ini" — satu sumber, supaya keduanya tidak bisa menyimpang.
 */
export function absoluteTime(iso: string, locale: Locale): string {
  const shifted = new Date(new Date(iso).getTime() + UTC_OFFSET_MINUTES * 60_000);
  return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    // Offset kantor sudah dijumlahkan ke dalam nilainya, jadi yang diformat
    // WAJIB dibaca sebagai UTC. Tanpa ini zona waktu proses ikut ditambahkan
    // untuk kedua kalinya — benar di laptop yang kebetulan WIB, salah dua kali
    // di Vercel.
    timeZone: 'UTC',
  }).format(shifted);
}
