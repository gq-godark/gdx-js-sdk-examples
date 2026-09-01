/**
 * Per-connection HPKE sealed session (replaces HPKE CryptoSession).
 */

import {
  infoForConn,
  nonceFromU64,
  setupSession,
  TAG_LEN,
  type SealedSession,
} from './hpke.js';
import { parseWireU64 } from './proto.js';

const NOT_ESTABLISHED = 'HPKE session not established';

export class CryptoSession {
  private _sealed: SealedSession | null = null;
  private _pendingSealed: SealedSession | null = null;
  private _pendingConnId = 0n;
  private _connId = 0n;
  /** Cleartext OrderHeader nonce counter (AAD only). Starts at 1 (Rust parity). */
  private _sendCounter = 1;
  private _seenRecvNonces = new Set<number>();

  get isEstablished(): boolean {
    return this._sealed !== null;
  }

  get connId(): bigint {
    return this._connId;
  }

  get nextNonce(): number {
    return this._sendCounter;
  }

  /**
   * HPKE Base setup against the pinned sequencer public key.
   * Returns the encapped key bytes for `TradingWsBinaryFrame.hpke_setup`.
   * The session is not established until `confirmSetup()` after peer reply.
   */
  async setup(
    recipientPublic: Uint8Array,
    userUuid: Uint8Array,
    connId: number | bigint,
  ): Promise<Uint8Array> {
    const conn = parseWireU64(connId);
    if (conn === 0n) {
      throw new Error(`conn_id must be a non-zero u64, got ${String(connId)}`);
    }
    const info = infoForConn(userUuid, conn);
    const { encappedKey, session } = await setupSession(recipientPublic, info);
    this._pendingSealed = session;
    this._pendingConnId = conn;
    return encappedKey;
  }

  /** Commit a pending HPKE setup after the sequencer confirms. */
  confirmSetup(): void {
    if (this._pendingSealed === null) {
      throw new Error('HPKE setup not pending peer confirmation');
    }
    this._sealed = this._pendingSealed;
    this._connId = this._pendingConnId;
    this._pendingSealed = null;
    this._pendingConnId = 0n;
    this._sendCounter = 1;
    this._seenRecvNonces.clear();
  }

  /** Discard a pending HPKE setup (timeout, rejection, or mismatch). */
  abortSetup(): void {
    this._pendingSealed = null;
    this._pendingConnId = 0n;
  }

  /** Attach an already-opened sealed session for this WebSocket `conn_id`. */
  attachSession(sealed: SealedSession, connId: number | bigint): void {
    const conn = parseWireU64(connId);
    if (conn === 0n) {
      throw new Error(`conn_id must be a non-zero u64, got ${String(connId)}`);
    }
    this._sealed = sealed;
    this._connId = conn;
    this._sendCounter = 1;
    this._seenRecvNonces.clear();
  }

  /** @deprecated Use {@link attachSession} */
  establish(sealed: SealedSession, connId: number | bigint): void {
    this.attachSession(sealed, connId);
  }

  /**
   * Encrypt order plaintext under HPKE c2s AES-GCM.
   * Caller supplies pre-built OrderHeader AAD bytes.
   */
  encryptOrder(aad: Buffer, plaintext: Buffer): [number, Buffer] {
    const sealed = this.requireSealed();
    const nonce = this._sendCounter;
    if (nonce > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Send nonce counter exceeded safe integer range');
    }
    if (nonce === 0xffffffffffffffff) {
      throw new RangeError('Send nonce counter overflow');
    }
    const ciphertext = Buffer.from(
      sealed.sealC2s(nonceFromU64(nonce), aad, plaintext),
    );
    const expectedLen = CryptoSession.bodyLengthForPlaintext(plaintext.length);
    if (ciphertext.length !== expectedLen) {
      throw new Error(
        `encryptOrder: ciphertext length ${ciphertext.length} != planned body_length ${expectedLen}`,
      );
    }
    this._sendCounter = nonce + 1;
    return [nonce, ciphertext];
  }

  /** HPKE s2c decrypt for an encrypted_push (AAD must include matching conn_id). */
  decryptPush(envelopeNonce: number, aad: Buffer, ciphertext: Buffer): Buffer {
    const sealed = this.requireSealed();
    if (!Number.isFinite(envelopeNonce) || envelopeNonce < 0) {
      throw new Error(`invalid envelope nonce: ${envelopeNonce}`);
    }
    if (this._seenRecvNonces.has(envelopeNonce)) {
      throw new Error(`replay detected: push nonce ${envelopeNonce} already seen`);
    }
    const pt = Buffer.from(
      sealed.openS2c(nonceFromU64(envelopeNonce), aad, ciphertext),
    );
    this._seenRecvNonces.add(envelopeNonce);
    return pt;
  }

  /** Ciphertext body length for OrderHeader / ResponseHeader planning. */
  static bodyLengthForPlaintext(plaintextLen: number): number {
    return plaintextLen + TAG_LEN;
  }

  reset(): void {
    this._sealed = null;
    this._pendingSealed = null;
    this._pendingConnId = 0n;
    this._connId = 0n;
    this._sendCounter = 1;
    this._seenRecvNonces.clear();
  }

  private requireSealed(): SealedSession {
    if (!this._sealed) {
      throw new Error(NOT_ESTABLISHED);
    }
    return this._sealed;
  }
}
