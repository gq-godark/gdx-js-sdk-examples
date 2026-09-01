/** Base error for all SDK errors. */
export class GodarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GodarkError';
  }
}

/** API key auth failed. */
export class AuthenticationError extends GodarkError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** ECDH session setup or rekey failed. */
export class SessionError extends GodarkError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Order was rejected by the sequencer. */
export class OrderError extends GodarkError {
  readonly errorCode: string | undefined;

  constructor(message: string, errorCode?: string) {
    super(message);
    this.name = 'OrderError';
    this.errorCode = errorCode;
  }
}

/** WebSocket transport failure. */
export class ConnectionError extends GodarkError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** AES-GCM encryption or decryption failed. */
export class EncryptionError extends GodarkError {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/** Command timed out waiting for response. */
export class TimeoutError extends GodarkError {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
