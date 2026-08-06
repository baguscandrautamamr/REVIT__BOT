// Kontrak i18n — satu-satunya sumber kebenaran bentuk katalog.
// `id.ts` adalah katalog referensi; `en.ts` wajib mengikuti bentuk yang sama
// (dipaksa lewat `satisfies Catalog` supaya key yang hilang gagal saat compile).

export type Locale = 'id' | 'en';

export const LOCALES: readonly Locale[] = ['id', 'en'] as const;

/** Dipakai saat user belum pernah memilih bahasa dan Telegram tidak mengirim hint. */
export const DEFAULT_LOCALE: Locale = 'id';

/** Nilai yang boleh disimpan di kolom `bot_users.lang`. */
export type LangPref = Locale | 'auto';

/** Parameter interpolasi: `{name}` di string diganti dari objek ini. */
export type Params = Record<string, string | number>;

/**
 * Node katalog: string biasa, atau fungsi kalau butuh logika
 * (plural, daftar dinamis). Nested object untuk pengelompokan.
 */
export type Node = string | ((p: Params) => string);

export interface Catalog {
  meta: {
    /** Nama bahasa dalam bahasanya sendiri — dipakai di menu /lang. */
    nativeName: string;
    /** Kode BCP-47 untuk `setMyCommands(language_code)`. */
    bcp47: string;
    flag: string;
  };
  common: Record<string, Node>;
  errors: Record<string, Node>;
  help: Record<string, Node>;
  status: Record<string, Node>;
  count: Record<string, Node>;
  exportFile: Record<string, Node>;
  confirm: Record<string, Node>;
  admin: Record<string, Node>;
  lang: Record<string, Node>;
  commandDesc: Record<string, string>;
}
