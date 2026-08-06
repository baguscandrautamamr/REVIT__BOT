import crypto from 'node:crypto';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const API = `https://api.telegram.org/bot${TOKEN}`;

/**
 * Escape MarkdownV2. Telegram menolak seluruh pesan (bukan cuma bagiannya)
 * kalau ada satu karakter reserved yang tidak di-escape — dan daftar ini
 * lebih panjang dari dugaan orang: titik dan tanda hubung ikut di dalamnya,
 * jadi "LP-01." saja sudah cukup untuk membuat sendMessage gagal 400.
 *
 * Daftar resmi: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function mdv2(s: string): string {
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

/** Blok kode aman: hanya ` dan \ yang perlu di-escape di dalamnya. */
export function code(s: string): string {
  return '```\n' + escapeInCode(s) + '\n```';
}

function escapeInCode(s: string): string {
  return s.replace(/[`\\]/g, (c) => '\\' + c);
}

/** Panjang pagar blok kode: "```\n" di depan + "\n```" di belakang. */
const FENCE_OVERHEAD = 8;

/**
 * Teks bebas → SATU ATAU LEBIH blok kode, masing-masing di bawah batas
 * Telegram.
 *
 * `code()` tidak cukup untuk hasil yang datang dari Revit: `/sheets` pada
 * proyek dengan ratusan sheet, atau `/count --detail` pada lantai yang padat,
 * dengan mudah melewati 4096 karakter — dan Telegram menolak SELURUH pesan
 * dengan 400, bukan memotongnya. Akibatnya kerja Revit yang sudah selesai
 * terbuang dan pesan "⏳" milik user tidak pernah berubah.
 *
 * Escaping dilakukan SEBELUM pemotongan, bukan sesudah: `chunk()` sudah menjaga
 * agar tidak ada potongan yang berakhir dengan backslash menggantung, dan itu
 * satu-satunya urutan yang membuat penjagaan itu ada gunanya di sini.
 */
export function codeBlocks(s: string, limit = MAX_TEXT): string[] {
  const escaped = escapeInCode(s);
  if (!escaped) return [];
  return chunk(escaped, limit - FENCE_OVERHEAD).map((part) => '```\n' + part + '\n```');
}

/** Batas keras Telegram: 4096 karakter per pesan teks. */
export const MAX_TEXT = 4096;
/** Batas caption untuk sendDocument / sendPhoto. */
export const MAX_CAPTION = 1024;

/** Potong di batas baris supaya tabel tidak terbelah di tengah baris. */
export function chunk(text: string, limit = MAX_TEXT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = '';

  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > limit) { out.push(buf); buf = ''; }

    // Satu baris yang sendirian sudah melebihi batas tidak bisa diselamatkan
    // oleh pemotongan per baris. Tanpa penanganan di sini ia diloloskan apa
    // adanya dan Telegram menolak SELURUH pesan dengan 400 — satu nama sheet
    // yang kepanjangan cukup untuk membuat /help gagal total.
    if (line.length > limit) {
      for (const piece of hardSplit(line, limit)) {
        if (buf) { out.push(buf); buf = ''; }
        out.push(piece);
      }
      continue;
    }

    buf += (buf ? '\n' : '') + line;
  }

  if (buf) out.push(buf);
  return out;
}

/**
 * Pecah paksa satu baris panjang, tanpa pernah memisahkan `\` dari karakter
 * yang di-escape-nya: `mdv2()` menghasilkan pasangan seperti `\.` dan `\-`,
 * dan potongan yang berakhir dengan backslash menggantung membuat Telegram
 * menolak potongan itu sekaligus yang berikutnya.
 */
function hardSplit(line: string, limit: number): string[] {
  const out: string[] = [];
  let rest = line;

  while (rest.length > limit) {
    let cut = limit;
    let backslashes = 0;
    while (cut - 1 - backslashes >= 0 && rest[cut - 1 - backslashes] === '\\') backslashes++;
    if (backslashes % 2 === 1) cut--; // jangan tinggalkan backslash menggantung

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest) out.push(rest);
  return out;
}

async function call<T = unknown>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Teks dulu, baru parse: balasan non-JSON (halaman error proxy, 502 dari
  // gateway) akan melempar "Unexpected token '<'" yang tidak menjelaskan apa pun.
  const raw = await res.text();
  let json: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${method}: balasan bukan JSON (HTTP ${res.status}). Isi awal: ${raw.slice(0, 160)}`);
  }

  if (!json.ok) {
    // 429 membawa `retry_after` dalam detik. Naikkan sebagai error bertipe
    // supaya pemanggil bisa memutuskan menunda, bukan mengulang langsung.
    const wait = json.parameters?.retry_after;
    throw Object.assign(new Error(`${method}: ${json.description}`), { retryAfter: wait });
  }
  return json.result as T;
}

export interface SentMessage { message_id: number }

export function sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return call<SentMessage>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/** Dipakai untuk mengubah pesan "⏳" jadi hasil — bukan mengirim pesan baru. */
export function editMessageText(chatId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'MarkdownV2',
    ...extra,
  });
}

export function answerCallbackQuery(id: string, text?: string, showAlert = false) {
  return call('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
}

/**
 * Kirim file. WAJIB sendDocument untuk PDF/DWG — sendPhoto mengompres ke JPG
 * dan presisi gambar kerja hilang. Batas upload bot: 50 MB.
 */
export async function sendDocument(
  chatId: number,
  file: { name: string; bytes: Uint8Array | Buffer },
  caption?: string,
) {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  const bytes = Buffer.isBuffer(file.bytes) ? new Uint8Array(file.bytes) : file.bytes;
  const body = new Uint8Array(bytes);
  form.set('document', new Blob([body], { type: 'application/octet-stream' }), file.name);
  if (caption) {
    form.set('caption', caption.slice(0, MAX_CAPTION));
    form.set('parse_mode', 'MarkdownV2');
  }
  const res = await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`sendDocument: ${json.description}`);
  return json;
}

/**
 * Verifikasi header `X-Telegram-Bot-Api-Secret-Token` pada webhook.
 * Nilai ini ditentukan saat `setWebhook(secret_token: …)`. Tanpa ini,
 * siapa pun yang tahu URL webhook bisa mengirim update palsu.
 */
export function verifyWebhookSecret(header: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifikasi `initData` dari Telegram Mini App (panel web).
 *
 * Algoritma resmi:
 *   secret = HMAC_SHA256(key="WebAppData", data=bot_token)
 *   hash   = HMAC_SHA256(key=secret,      data=data_check_string)
 * di mana data_check_string = semua pasangan `k=v` KECUALI `hash`,
 * diurutkan alfabetis, digabung dengan "\n".
 *
 * Catatan: skema Login Widget BERBEDA (secret = SHA256(bot_token)).
 * Jangan tertukar — verifikasi akan selalu gagal.
 */
export function verifyInitData(initData: string, maxAgeSeconds = 3600):
  | { ok: true; user: { id: number; language_code?: string } }
  | { ok: false; reason: string } {
  if (!initData) return { ok: false, reason: 'empty' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad hash' };
  }

  // auth_date mencegah replay: initData lama tidak boleh dipakai selamanya.
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'stale' };
  }

  try {
    const user = JSON.parse(params.get('user') ?? '{}');
    if (typeof user.id !== 'number') return { ok: false, reason: 'no user' };
    return { ok: true, user };
  } catch {
    return { ok: false, reason: 'bad user json' };
  }
}
