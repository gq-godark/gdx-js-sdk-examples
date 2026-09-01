import crypto from 'node:crypto';

const HKDF_INFO = Buffer.from('gdx-e2e-session-key-v1');
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

export const GCM_TAG_LEN = 16;

export function generateEphemeralKeypair(): [crypto.KeyObject, Buffer] {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  return [privateKey, Buffer.from(rawPub)];
}

export function deriveSessionKey(
  privateKey: crypto.KeyObject,
  localPublic: Buffer,
  remotePublic: Buffer,
): Buffer {
  const remoteDer = Buffer.concat([X25519_SPKI_HEADER, remotePublic]);
  const remoteKey = crypto.createPublicKey({ key: remoteDer, format: 'der', type: 'spki' });

  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey: remoteKey });

  if (sharedSecret.every((b: number) => b === 0)) {
    throw new Error('Weak public key: ECDH shared secret is all zeros');
  }

  // HKDF salt: min(local, remote) || max(local, remote) (byte-lexicographic)
  const salt = Buffer.compare(localPublic, remotePublic) <= 0
    ? Buffer.concat([localPublic, remotePublic])
    : Buffer.concat([remotePublic, localPublic]);

  const derived = crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32);
  return Buffer.from(derived);
}

export function buildGcmNonce(sessionId: number, nonceCounter: number): Buffer {
  if (nonceCounter > 0xFFFFFFFF) {
    throw new RangeError(`Nonce counter ${nonceCounter} exceeds u32 max`);
  }
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(sessionId), 0);
  nonce.writeUInt32BE(nonceCounter, 8);
  return nonce;
}

export function encrypt(
  key: Buffer,
  nonceCounter: number,
  sessionId: number,
  aad: Buffer,
  plaintext: Buffer,
): Buffer {
  const nonce = buildGcmNonce(sessionId, nonceCounter);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]);
}

export function decrypt(
  key: Buffer,
  nonceCounter: number,
  sessionId: number,
  aad: Buffer,
  ciphertext: Buffer,
): Buffer {
  const nonce = buildGcmNonce(sessionId, nonceCounter);
  const ct = ciphertext.subarray(0, ciphertext.length - GCM_TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export class NonceTracker {
  private _sendCounter = 0;
  private _lastRecv: number | undefined;

  peekNext(): number {
    return this._sendCounter;
  }

  get lastRecv(): number | undefined {
    return this._lastRecv;
  }

  advance(): number {
    const n = this._sendCounter;
    if (n > 0xFFFFFFFF) {
      throw new RangeError('Send nonce counter exceeded u32 max');
    }
    this._sendCounter = n + 1;
    return n;
  }

  commitRecv(received: number): void {
    this._lastRecv = received;
  }

  reset(): void {
    this._sendCounter = 0;
    this._lastRecv = undefined;
  }
}
