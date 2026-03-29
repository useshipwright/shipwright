import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class TokenEncryptor {
  private key: Uint8Array | null = null;
  private readonly client: SecretManagerServiceClient;
  private readonly secretName: string;

  constructor(projectId: string, secretId: string, version = 'latest') {
    this.client = new SecretManagerServiceClient();
    this.secretName = `projects/${projectId}/secrets/${secretId}/versions/${version}`;
  }

  private async getKey(): Promise<Uint8Array> {
    if (this.key) {
      return this.key;
    }

    const [response] = await this.client.accessSecretVersion({
      name: this.secretName,
    });

    const payload = response.payload?.data;
    if (!payload) {
      throw new Error(
        `Secret Manager key unavailable: no payload returned for ${this.secretName}`,
      );
    }

    const raw =
      typeof payload === 'string'
        ? new Uint8Array(Buffer.from(payload, 'base64'))
        : new Uint8Array(payload);

    if (raw.length !== KEY_LENGTH) {
      throw new Error(
        `Secret Manager key must be exactly ${KEY_LENGTH} bytes (got ${raw.length})`,
      );
    }

    this.key = raw;
    return this.key;
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Returns a base64 string containing IV + ciphertext + auth tag.
   */
  async encrypt(plaintext: string): Promise<string> {
    const key = await this.getKey();
    const iv = new Uint8Array(randomBytes(IV_LENGTH));
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encryptedBuf = cipher.update(plaintext, 'utf8');
    const finalBuf = cipher.final();
    const authTag = new Uint8Array(cipher.getAuthTag());

    const encrypted = new Uint8Array(encryptedBuf.length + finalBuf.length);
    encrypted.set(new Uint8Array(encryptedBuf));
    encrypted.set(new Uint8Array(finalBuf), encryptedBuf.length);

    // Layout: [IV (12)] [ciphertext (variable)] [authTag (16)]
    const combined = new Uint8Array(IV_LENGTH + encrypted.length + AUTH_TAG_LENGTH);
    combined.set(iv, 0);
    combined.set(encrypted, IV_LENGTH);
    combined.set(authTag, IV_LENGTH + encrypted.length);

    return Buffer.from(combined).toString('base64');
  }

  /**
   * Decrypt a base64 string produced by encrypt().
   * Returns the original plaintext.
   */
  async decrypt(ciphertext: string): Promise<string> {
    const key = await this.getKey();
    const combined = new Uint8Array(Buffer.from(ciphertext, 'base64'));

    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Invalid ciphertext: too short');
    }

    const iv = combined.slice(0, IV_LENGTH);
    const authTag = combined.slice(combined.length - AUTH_TAG_LENGTH);
    const encrypted = combined.slice(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const decryptedBuf = decipher.update(encrypted);
    const finalBuf = decipher.final();

    const decrypted = new Uint8Array(decryptedBuf.length + finalBuf.length);
    decrypted.set(new Uint8Array(decryptedBuf));
    decrypted.set(new Uint8Array(finalBuf), decryptedBuf.length);

    return new TextDecoder().decode(decrypted);
  }
}
