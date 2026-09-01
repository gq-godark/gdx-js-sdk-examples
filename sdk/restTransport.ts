/** Thin fetch wrapper for docs-shaped REST envelopes under `/api/v1`. */

export class RestEnvelopeError extends Error {
  constructor(
    public readonly code: number,
    message?: string,
  ) {
    super(message ?? `REST envelope code ${code}`);
    this.name = 'RestEnvelopeError';
  }
}

export function unwrapEnvelope(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new RestEnvelopeError(1500, 'invalid JSON');
  const v = raw as Record<string, unknown>;
  const code = Number(v.code ?? 1);
  if (code !== 0) {
    throw new RestEnvelopeError(code, typeof v.message === 'string' ? v.message : undefined);
  }
  const data = v.data;
  if (!data || typeof data !== 'object') throw new RestEnvelopeError(1500, 'missing data');
  return data as Record<string, unknown>;
}

export interface AuthTokenDocsBody {
  grant_type: string;
  client_id: string;
  client_secret: string;
  passphrase?: string;
}

export class RestTransport {
  constructor(private readonly baseUrl: string) {}

  /** HTTP origin used for public REST calls. */
  get origin(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async timePublic(): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/time'));
    if (!r.ok) throw new Error(`GET /time ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async instrumentsPublic(): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/instruments'));
    if (!r.ok) throw new Error(`GET /api/v1/instruments ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async authTokenDocs(body: AuthTokenDocsBody): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/auth/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST /auth/token ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async authTokenLegacy(token: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/auth/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) throw new Error(`POST /auth/token ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  /** @deprecated ECDH REST session setup is retired (HPKE is WS-only). Not used by GodarkRestClient. */
  async sessionSetup(bearer: string, clientEcdhPubkey: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/session/setup'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ client_ecdh_pubkey: clientEcdhPubkey }),
    });
    if (!r.ok) throw new Error(`POST /session/setup ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async postOrdersEncrypted(
    bearer: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/orders'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST /orders ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async deleteOrdersEncrypted(
    bearer: string,
    orderId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.url(`/api/v1/orders/${encodeURIComponent(orderId)}`), {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`DELETE /orders ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async deleteOrdersEncryptedByClientOrderId(
    bearer: string,
    clientOrderId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ client_order_id: clientOrderId });
    const r = await fetch(this.url(`/api/v1/orders?${q}`), {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`DELETE /orders?client_order_id= ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async patchOrdersEncrypted(
    bearer: string,
    orderId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.url(`/api/v1/orders/${encodeURIComponent(orderId)}`), {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH /orders ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async getOrder(bearer: string, orderId: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url(`/api/v1/orders/${encodeURIComponent(orderId)}`), {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) throw new Error(`GET /orders/${orderId} ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async getOrderByClientOrderId(bearer: string, clientOrderId: string): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ client_order_id: clientOrderId });
    const r = await fetch(this.url(`/api/v1/orders?${q}`), {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) throw new Error(`GET /orders?client_order_id= ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async registerClientOrderMapping(
    bearer: string,
    clientOrderId: string,
    orderId: string,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/orders/_register_coid'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ client_order_id: clientOrderId, order_id: orderId }),
    });
    if (!r.ok) throw new Error(`POST /orders/_register_coid ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async getAuthMe(bearer: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/auth/me'), {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) throw new Error(`GET /auth/me ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  }

  async getShieldedPoolBalances(bearer: string, owner: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url(`/api/v1/shielded-pool/balances/${encodeURIComponent(owner)}`), {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) throw new Error(`GET /shielded-pool/balances/${owner} ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  }

  async revokeToken(bearer: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/auth/token/revoke'), {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) throw new Error(`POST /auth/token/revoke ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async getLeverage(bearer: string): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/leverage'), {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) throw new Error(`GET /leverage ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async postLeverageEncrypted(
    bearer: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/leverage'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST /leverage ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  async postEncrypted(
    bearer: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.url(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} ${r.status}`);
    return unwrapEnvelope(await r.json());
  }

  /** `GET /api/v1/market-data/funding-rates` — public, raw JSON array (no envelope). */
  async getFundingRates(): Promise<unknown[]> {
    const r = await fetch(this.url('/api/v1/market-data/funding-rates'));
    if (!r.ok) throw new Error(`GET /market-data/funding-rates ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('expected funding-rates array');
    return data;
  }

  /** `GET /api/v1/market-data/open-interest` — public, raw JSON array (no envelope). */
  async getOpenInterest(): Promise<unknown[]> {
    const r = await fetch(this.url('/api/v1/market-data/open-interest'));
    if (!r.ok) throw new Error(`GET /market-data/open-interest ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('expected open-interest array');
    return data;
  }

  /** `GET /api/v1/market-data/volume` — public, raw JSON object (no envelope). */
  async getVolume(): Promise<Record<string, unknown>> {
    const r = await fetch(this.url('/api/v1/market-data/volume'));
    if (!r.ok) throw new Error(`GET /market-data/volume ${r.status}`);
    const data = await r.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('expected volume object');
    }
    return data as Record<string, unknown>;
  }
}
