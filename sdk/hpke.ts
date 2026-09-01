/**
 * HPKE Base (RFC 9180) for trading E2E — matches Rust `hpke.rs` / `gdx_crypto::hpke`.
 *
 * Suite: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM.
 * After setup, peers export directional keys and seal each message with an
 * explicit 96-bit nonce (`0u32_be ‖ counter_be`).
 */

import { gcm } from '@noble/ciphers/aes.js';
import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from '@hpke/core';

export const KEY_LEN = 32;
export const ENCAPPED_KEY_LEN = 32;
export const TAG_LEN = 16;
export const WIRE_VERSION = 2;

const INFO_DOMAIN = new TextEncoder().encode('gdx-hpke/v1\0');
const INFO_DOMAIN_REST = new TextEncoder().encode('gdx-hpke/v1/rest\0');
export const EXPORT_C2S = new TextEncoder().encode('gdx-hpke/v1 c2s');
export const EXPORT_S2C = new TextEncoder().encode('gdx-hpke/v1 s2c');

const SUITE = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

/** `gdx-hpke/v1/rest\0 ‖ user_uuid ‖ request_id_be` */
export function infoForRestRequest(userUuid: Uint8Array, requestId: number | bigint): Uint8Array {
  if (userUuid.length !== 16) {
    throw new Error(`userUuid must be 16 bytes, got ${userUuid.length}`);
  }
  const out = new Uint8Array(INFO_DOMAIN_REST.length + 16 + 8);
  out.set(INFO_DOMAIN_REST, 0);
  out.set(userUuid, INFO_DOMAIN_REST.length);
  const view = new DataView(out.buffer, INFO_DOMAIN_REST.length + 16, 8);
  view.setBigUint64(0, BigInt(requestId), false);
  return out;
}

/** `gdx-hpke/v1\0 ‖ user_uuid ‖ conn_id_be` */
export function infoForConn(userUuid: Uint8Array, connId: number | bigint): Uint8Array {
  if (userUuid.length !== 16) {
    throw new Error(`userUuid must be 16 bytes, got ${userUuid.length}`);
  }
  const out = new Uint8Array(INFO_DOMAIN.length + 16 + 8);
  out.set(INFO_DOMAIN, 0);
  out.set(userUuid, INFO_DOMAIN.length);
  const view = new DataView(out.buffer, INFO_DOMAIN.length + 16, 8);
  view.setBigUint64(0, BigInt(connId), false);
  return out;
}

/** Pack monotonic u64 into 96-bit GCM nonce: `0u32_be ‖ counter_be`. */
export function nonceFromU64(counter: number | bigint): Uint8Array {
  const n = typeof counter === 'bigint' ? counter : BigInt(counter);
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setBigUint64(4, n, false);
  return out;
}

export function parsePinnedStaticPublicKeyHex(hex: string): Uint8Array {
  const stripped = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`HPKE static public key must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars)`);
  }
  const out = new Uint8Array(KEY_LEN);
  for (let i = 0; i < KEY_LEN; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface StaticKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export async function generateStaticKeyPair(): Promise<StaticKeyPair> {
  const kem = SUITE.kem;
  const kp = await kem.generateKeyPair();
  return {
    privateKey: new Uint8Array(await kem.serializePrivateKey(kp.privateKey)),
    publicKey: new Uint8Array(await kem.serializePublicKey(kp.publicKey)),
  };
}

export class SealedSession {
  private constructor(
    private readonly kC2s: Uint8Array,
    private readonly kS2c: Uint8Array,
  ) {}

  static fromExported(kC2s: Uint8Array, kS2c: Uint8Array): SealedSession {
    if (kC2s.length !== KEY_LEN || kS2c.length !== KEY_LEN) {
      throw new Error('HPKE exported keys must be 32 bytes');
    }
    return new SealedSession(kC2s.slice(), kS2c.slice());
  }

  sealC2s(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return aesGcm(this.kC2s, nonce, aad, plaintext, 'encrypt');
  }

  openC2s(nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    return aesGcm(this.kC2s, nonce, aad, ciphertext, 'decrypt');
  }

  sealS2c(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return aesGcm(this.kS2c, nonce, aad, plaintext, 'encrypt');
  }

  openS2c(nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    return aesGcm(this.kS2c, nonce, aad, ciphertext, 'decrypt');
  }
}

function aesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
  op: 'encrypt' | 'decrypt',
): Uint8Array {
  if (nonce.length !== 12) {
    throw new Error('AES-GCM nonce must be 12 bytes');
  }
  const cipher = gcm(key, nonce, aad);
  return op === 'encrypt' ? cipher.encrypt(data) : cipher.decrypt(data);
}

async function exportPair(ctx: {
  export: (context: ArrayBufferView, len: number) => Promise<ArrayBuffer>;
}): Promise<SealedSession> {
  const c2s = new Uint8Array(await ctx.export(EXPORT_C2S, KEY_LEN));
  const s2c = new Uint8Array(await ctx.export(EXPORT_S2C, KEY_LEN));
  return SealedSession.fromExported(c2s, s2c);
}

/** Client (initiator): encapsulate to sequencer pubkey. */
export async function setupSession(
  recipientPublic: Uint8Array,
  info: Uint8Array,
): Promise<{ encappedKey: Uint8Array; session: SealedSession }> {
  if (recipientPublic.length !== KEY_LEN) {
    throw new Error(`recipient public key must be ${KEY_LEN} bytes`);
  }
  const pk = await SUITE.kem.deserializePublicKey(recipientPublic);
  const sender = await SUITE.createSenderContext({ recipientPublicKey: pk, info });
  const encappedKey = new Uint8Array(sender.enc);
  if (encappedKey.length !== ENCAPPED_KEY_LEN) {
    throw new Error(`unexpected encapped key length ${encappedKey.length}`);
  }
  const session = await exportPair(sender);
  return { encappedKey, session };
}

/** Sequencer (recipient): open encapped key with static private key (tests / mock edge). */
export async function openSession(
  recipient: StaticKeyPair,
  encappedKey: Uint8Array,
  info: Uint8Array,
): Promise<SealedSession> {
  if (recipient.privateKey.length !== KEY_LEN) {
    throw new Error(`recipient private key must be ${KEY_LEN} bytes`);
  }
  if (encappedKey.length !== ENCAPPED_KEY_LEN) {
    throw new Error(`encapped key must be ${ENCAPPED_KEY_LEN} bytes`);
  }
  const sk = await SUITE.kem.deserializePrivateKey(recipient.privateKey);
  const recip = await SUITE.createRecipientContext({
    recipientKey: sk,
    enc: encappedKey,
    info,
  });
  return exportPair(recip);
}
