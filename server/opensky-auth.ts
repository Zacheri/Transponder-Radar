const DEFAULT_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const DEFAULT_REFRESH_MARGIN_MS = 60_000;

export interface TokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}

export interface TokenProviderOpts {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshMarginMs?: number;
}

// OAuth2 client-credentials flow (OpenSky dropped Basic auth in March 2026).
// Tokens expire in 30 minutes; this provider caches one and proactively
// refreshes `refreshMarginMs` before expiry.
export function createTokenProvider(opts: TokenProviderOpts): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL;
  const margin = opts.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  let token: string | null = null;
  let expiresAt = 0;

  async function fetchToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("token response missing access_token");
    token = data.access_token;
    expiresAt = now() + (data.expires_in ?? 1800) * 1000;
  }

  return {
    async getToken(): Promise<string> {
      if (token && now() < expiresAt - margin) return token;
      await fetchToken();
      return token as string;
    },
    invalidate(): void {
      token = null;
      expiresAt = 0;
    },
  };
}
