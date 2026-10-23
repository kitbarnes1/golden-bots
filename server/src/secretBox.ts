import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals small secrets (the OpenRouter key) for storing in the database, with
 * AES-256-GCM. The encryption key is random and kept in a file of its own, so
 * the database on its own (a backup, say) holds nothing usable.
 */
export class SecretBox {
  constructor(private readonly keyFile: string) {}

  seal(plain: string): string {
    const key = this.key() ?? this.createKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  }

  /** The secret, or null if it can't be opened: the key file is missing or has changed, or the value was tampered with. */
  open(sealed: string): string | null {
    const [version, iv, tag, data] = sealed.split(':');
    const key = this.key();
    if (version !== 'v1' || !iv || !tag || data === undefined || !key) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: TAG_BYTES });
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private key(): Buffer | null {
    let text: string;
    try {
      text = fs.readFileSync(this.keyFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const key = Buffer.from(text.trim(), 'base64');
    return key.length === KEY_BYTES ? key : null;
  }

  /** Only made when there's first something to seal, readable by this user alone. */
  private createKey(): Buffer {
    if (fs.existsSync(this.keyFile)) {
      // Never replace a key file we can't read: whatever it sealed would be lost for good.
      throw new Error(`${this.keyFile} is not a valid encryption key. Move it aside to have a new one made.`);
    }
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    fs.writeFileSync(this.keyFile, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  }
}
