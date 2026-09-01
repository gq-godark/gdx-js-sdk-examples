/**
 * Helpers for GoDark REST access JWTs minted by `POST /api/v1/auth/token`.
 *
 * Signature verification is performed by the edge; the SDK only decodes the
 * payload to read stable claims such as `sub` (internal user UUID).
 */

/** Parse the internal user UUID from a compact access JWT's `sub` claim. */
export function userUuidFromAccessTokenJwt(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const sub = payload.sub;
    if (typeof sub !== 'string' || !sub.trim()) return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) {
      return undefined;
    }
    return sub;
  } catch {
    return undefined;
  }
}
