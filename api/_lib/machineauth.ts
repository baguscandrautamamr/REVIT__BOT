/**
 * Bearer token milik mesin, dibandingkan dengan waktu konstan.
 *
 * Dipisah ke sini karena sekarang dipakai tiga endpoint (claim, report,
 * upload-url). `!==` biasa membocorkan panjang prefix yang cocok lewat waktu
 * eksekusi; di jaringan itu sulit dieksploitasi, tapi tidak ada alasan memilih
 * yang lemah — dan menyalin logikanya untuk ketiga kalinya adalah cara termudah
 * membuat salah satunya menyimpang tanpa ada yang menyadari.
 */
import type { VercelRequest } from '@vercel/node';
import crypto from 'node:crypto';

import { ENV } from './env';

export function authorized(req: VercelRequest): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !ENV.machineToken) return false;

  const a = Buffer.from(token);
  const b = Buffer.from(ENV.machineToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
