/**
 * Siapa PC yang memanggil /api/machine/*.
 *
 * Dipakai tiga endpoint (claim, report, upload-url). Dipisah ke sini karena
 * menyalin logikanya untuk ketiga kalinya adalah cara termudah membuat salah
 * satunya menyimpang tanpa ada yang menyadari.
 *
 * ── Dua jalur, dan URUTANNYA menentukan ────────────────────────────────────
 *
 *   1. Hash token dicari di tabel `machines`  → ketemu & aktif? itu PC-nya.
 *   2. Token dibandingkan dengan MACHINE_TOKEN → PC lama, dari sebelum tabelnya
 *      ada.
 *
 * Jalur 2 TIDAK BOLEH DIHAPUS sebelum PC yang sekarang berjalan dipindahkan ke
 * tabel. Membuangnya lebih dulu membuat satu-satunya PC yang ada langsung dijawab
 * 401 — dan karena add-in hanya mencatat "claim 401" di berkas log di PC itu,
 * yang terlihat dari Telegram cuma "PC offline" untuk PC yang justru menyala.
 */
import type { VercelRequest } from '@vercel/node';
import crypto from 'node:crypto';

import * as db from './db';
import { ENV } from './env';

/**
 * Identitas pemanggil.
 *
 * `env` sengaja BUKAN objek Machine karangan. Membuat baris palsu berarti ada id
 * yang tidak menunjuk ke apa pun beredar di dalam kode, dan begitu routing
 * per-PC dipasang, id itu akan dipakai memfilter job — lalu tidak cocok dengan
 * satu baris pun, tanpa satu pun error.
 */
export type Caller =
  | { kind: 'row'; machine: db.Machine }
  | { kind: 'env' };

/** SHA-256 hex. Bentuk yang disimpan di `machines.token_hash`. */
export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function authorize(req: VercelRequest): Promise<Caller | null> {
  const token = bearer(req);
  if (!token) return null;

  const machine = await db.findMachineByTokenHash(tokenHash(token));
  if (machine) return machine.is_active ? { kind: 'row', machine } : null;

  if (ENV.machineToken && sameToken(token, ENV.machineToken)) return { kind: 'env' };
  return null;
}

/**
 * Bentuk boolean untuk endpoint yang belum peduli PC mana yang memanggil.
 *
 * Ada supaya perubahan ini tidak menyeret `report` dan `upload-url` ke urusan
 * identitas yang belum mereka butuhkan: keduanya bekerja pada satu job yang
 * id-nya sudah disebut di body, dan job itu sudah diikat ke barisnya sendiri.
 */
export async function authorized(req: VercelRequest): Promise<boolean> {
  return (await authorize(req)) !== null;
}

function bearer(req: VercelRequest): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/**
 * Perbandingan dengan waktu konstan.
 *
 * `!==` biasa membocorkan panjang prefix yang cocok lewat waktu eksekusi; di
 * jaringan itu sulit dieksploitasi, tapi tidak ada alasan memilih yang lemah.
 *
 * Jalur tabel tidak membutuhkannya: yang dibandingkan di sana adalah HASH, dan
 * pencariannya dikerjakan index database — bukan perbandingan byte per byte yang
 * lamanya bergantung pada isi tokennya.
 */
function sameToken(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
