/**
 * mupdf.js (WASM) based operations that pdf-lib cannot do: decryption,
 * encryption (AES-256), structural compression / garbage collection and
 * repair of damaged files.
 *
 * mupdf is AGPL-3.0 licensed; it is isolated here and loaded lazily so the
 * rest of the editor works without it.
 */
export interface MupdfApi {
  Document: {
    openDocument(data: Uint8Array, magic?: string): {
      needsPassword(): boolean;
      authenticatePassword(pw: string): number;
      asPDF(): { saveToBuffer(opts?: string): { asUint8Array(): Uint8Array }; countPages(): number } | null;
      countPages(): number;
      destroy?(): void;
    };
  };
}

export type MupdfLoader = () => Promise<MupdfApi>;

export const defaultMupdfLoader: MupdfLoader = async () => (await import('mupdf')) as unknown as MupdfApi;

function open(m: MupdfApi, bytes: Uint8Array, password?: string) {
  const doc = m.Document.openDocument(bytes, 'application/pdf');
  if (doc.needsPassword()) {
    if (!password) throw new PasswordRequiredError();
    if (!doc.authenticatePassword(password)) throw new PasswordRequiredError('Incorrect password');
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new Error('Not a PDF document');
  return pdf;
}

export class PasswordRequiredError extends Error {
  readonly code = 'PASSWORD_REQUIRED';
  constructor(msg = 'This document is password protected') {
    super(msg);
  }
}

export async function isEncrypted(m: MupdfApi, bytes: Uint8Array): Promise<boolean> {
  const doc = m.Document.openDocument(bytes, 'application/pdf');
  return doc.needsPassword();
}

export async function decrypt(m: MupdfApi, bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const pdf = open(m, bytes, password);
  return pdf.saveToBuffer('decrypt').asUint8Array().slice();
}

/** Repair / normalize a damaged file so pdf-lib can load it. */
export async function repair(m: MupdfApi, bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const pdf = open(m, bytes, password);
  return pdf.saveToBuffer('decrypt,garbage=1').asUint8Array().slice();
}

export interface EncryptOptions {
  userPassword: string;
  ownerPassword?: string;
  allowPrint?: boolean;
  allowCopy?: boolean;
  allowModify?: boolean;
  allowAnnotate?: boolean;
}

export async function encrypt(m: MupdfApi, bytes: Uint8Array, o: EncryptOptions): Promise<Uint8Array> {
  const pdf = open(m, bytes);
  // Permission bits per PDF spec table 22 (bits are 1-based).
  let p = -3904; // all reserved bits set, nothing allowed
  if (o.allowPrint !== false) p |= 1 << 2 | 1 << 11;
  if (o.allowModify) p |= 1 << 3 | 1 << 10;
  if (o.allowCopy !== false) p |= 1 << 4 | 1 << 9;
  if (o.allowAnnotate !== false) p |= 1 << 5 | 1 << 8;
  const esc = (s: string) => s.replace(/,/g, '');
  const opts = [
    'encrypt=aes-256',
    `user-password=${esc(o.userPassword)}`,
    `owner-password=${esc(o.ownerPassword || o.userPassword)}`,
    `permissions=${p}`,
    'garbage=1',
  ].join(',');
  return pdf.saveToBuffer(opts).asUint8Array().slice();
}

/** Structural compression: drop unused objects, deduplicate, deflate streams and fonts. */
export async function compressStructure(m: MupdfApi, bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = open(m, bytes);
  return pdf.saveToBuffer('garbage=deduplicate,compress,compress-fonts,compress-images,object-streams=yes').asUint8Array().slice();
}
