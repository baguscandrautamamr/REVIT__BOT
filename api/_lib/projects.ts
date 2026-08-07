/**
 * /project — memilih project mana yang dituju semua command berikutnya.
 *
 * Satu Revit bisa membuka beberapa file sekaligus. Sebelum ini bot selalu
 * bekerja pada dokumen yang sedang AKTIF, jadi orang yang duduk di depan PC
 * menentukan project siapa pun yang mengirim perintah dari HP — tanpa tahu ia
 * sedang menentukannya, dan tanpa satu pun cara bagi si pengirim untuk melihat
 * atau mengubahnya. Pilihan di sini melekat PER USER, jadi dua orang bisa
 * bekerja pada project berbeda di satu Revit yang sama.
 */
import * as db from './db';
import { translator, type Locale } from './i18n';
import { answerCallbackQuery, editMessageText, mdv2, sendMessage } from './telegram';

/** Prefix callback, dipisahkan dari `pref:` dan `confirm:`. */
export const PROJECT_PREFIX = 'project:';

/** Nilai khusus: kembali mengikuti dokumen yang aktif di Revit. */
const FOLLOW_ACTIVE = '*';

/**
 * Telegram membatasi `callback_data` 64 BYTE. Judul project di proyek nyata
 * jauh lebih panjang dari itu — "HBE-ELECTRICAL-D_FINISHED GOOD WAREHOUSE.rvt"
 * saja sudah 45, dan `project:` di depannya menyisakan 56. Yang dikirim karena
 * itu INDEKS, bukan judulnya; judulnya dibaca ulang dari `open_docs` saat
 * tombolnya ditekan.
 *
 * Indeks bisa bergeser kalau daftar file berubah di antara pesan dan tekan —
 * karena itu yang tersimpan diverifikasi lagi terhadap daftar terbaru, dan
 * pilihan yang sudah tidak ada dijawab dengan kalimat, bukan diam-diam meleset
 * ke project sebelahnya.
 */
function dataFor(index: number): string {
  return `${PROJECT_PREFIX}${index}`;
}

export async function handleProject(
  user: db.BotUser,
  machine: db.MachineState,
  args: string[],
  locale: Locale,
): Promise<void> {
  const t = translator(locale);
  const chatId = user.chat_id;

  if (!(await db.projectSelectionReady())) {
    await sendMessage(chatId, mdv2(t('project.needsMigration')));
    return;
  }

  const open = machine.open_docs ?? [];

  if (open.length === 0) {
    // Bedakan "Revit mati" dari "add-in lama". Keduanya menghasilkan daftar
    // kosong, tapi yang harus dikerjakan orangnya sama sekali berbeda.
    await sendMessage(chatId, mdv2(t('project.noneOpen')));
    return;
  }

  // Dengan argumen: `/project WAREHOUSE` — cocokkan tanpa perlu menekan tombol.
  const wanted = args.join(' ').trim();
  if (wanted) {
    const exact = open.find((d) => eq(d, wanted));
    const loose = open.filter((d) => has(d, wanted));
    const picked = exact ?? (loose.length === 1 ? loose[0] : null);

    if (!picked) {
      const why = loose.length > 1
        ? t('project.ambiguous', { term: wanted, n: loose.length })
        : t('project.notFound', { term: wanted });
      await sendMessage(chatId, mdv2(`${why}\n\n${open.map((d) => '· ' + d).join('\n')}`));
      return;
    }

    await db.updateUser(chatId, { project: picked });
    await sendMessage(chatId, mdv2(t('project.selected', { name: picked })));
    return;
  }

  await sendMessage(chatId, mdv2(t('project.prompt')), {
    reply_markup: { inline_keyboard: buttons(open, user.project ?? null, locale) },
  });
}

/** Tombol callback dari inline keyboard `/project`. */
export async function handleProjectCallback(
  query: { id: string; data: string; message?: { chat?: { id?: number }; message_id?: number } },
  user: db.BotUser,
  locale: Locale,
): Promise<void> {
  const t = translator(locale);
  const raw = query.data.slice(PROJECT_PREFIX.length);

  if (!(await db.projectSelectionReady())) {
    await answerCallbackQuery(query.id, t('project.needsMigration'), true);
    return;
  }

  let picked: string | null = null;

  if (raw !== FOLLOW_ACTIVE) {
    const machine = await db.getMachine();
    const open = machine.open_docs ?? [];
    const index = Number(raw);

    // Daftar file bisa berubah antara pesan dikirim dan tombol ditekan. Indeks
    // yang sudah tidak menunjuk ke mana-mana TIDAK dibulatkan ke tetangganya:
    // memilih project yang salah tanpa sadar adalah kegagalan yang baru
    // ketahuan setelah gambar kerjanya sampai ke orang lain.
    if (!Number.isInteger(index) || index < 0 || index >= open.length) {
      await answerCallbackQuery(query.id, t('project.stale'), true);
      return;
    }
    picked = open[index];
  }

  await db.updateUser(user.chat_id, { project: picked });
  await answerCallbackQuery(query.id);

  const text = picked ? t('project.selected', { name: picked }) : t('project.followActive');
  const chatId = query.message?.chat?.id ?? user.chat_id;
  const messageId = query.message?.message_id;

  if (messageId) {
    try {
      await editMessageText(chatId, messageId, mdv2(text));
      return;
    } catch {
      // Pesan aslinya bisa saja sudah dihapus user.
    }
  }
  await sendMessage(chatId, mdv2(text));
}

/**
 * Project yang dituju perintah user ini, atau null kalau ikut yang aktif.
 *
 * Pilihan yang menunjuk file yang SUDAH DITUTUP tidak diam-diam dibuang: ia
 * tetap dikirim ke add-in, dan add-in yang menjawab "project itu tidak terbuka
 * lagi" beserta daftar yang ada. Menggantinya di sini dengan dokumen aktif
 * berarti mengerjakan project yang tidak diminta siapa pun.
 */
export function targetProject(user: db.BotUser, machine: db.MachineState): string | null {
  return user.project ?? machine.active_doc ?? null;
}

function buttons(open: string[], current: string | null, locale: Locale) {
  const t = translator(locale);
  const rows = open.map((doc, i) => [
    { text: `${doc === current ? '● ' : ''}${short(doc)}`, callback_data: dataFor(i) },
  ]);

  rows.push([
    {
      text: `${current === null ? '● ' : ''}${t('project.followActiveButton')}`,
      callback_data: PROJECT_PREFIX + FOLLOW_ACTIVE,
    },
  ]);

  return rows;
}

/** Label tombol Telegram muat sekitar 30–40 karakter di layar ponsel. */
function short(name: string): string {
  const clean = name.replace(/\.rvt$/i, '');
  return clean.length <= 38 ? clean : clean.slice(0, 37) + '…';
}

function eq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function has(a: string, b: string): boolean {
  return a.toLowerCase().includes(b.trim().toLowerCase());
}
