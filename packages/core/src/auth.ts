import { PlaudConfig } from './config.js';
import { BASE_URLS, fetchRequester } from './types.js';
import type { PlaudTokenData, Requester } from './types.js';

// Every password login mints a NEW Plaud session (the JWT's `sid`), and the
// backend evicts older sessions for the account — which logs the phone app out.
// So we must reuse a cached token for as long as it is actually usable and only
// re-login when it is genuinely near expiry. The refresh buffer is derived from
// the token's own lifetime (Plaud currently issues ~30 days, not the ~300 days
// this code once assumed) and capped, so a shorter-lived token can never make
// `isExpiringSoon` permanently true and turn every request into a fresh login.
const MAX_REFRESH_BUFFER_MS = 6 * 60 * 60 * 1000; // 6 hours
const REFRESH_BUFFER_FRACTION = 0.05;             // or 5% of the token's lifetime

export class PlaudAuth {
  private config: PlaudConfig;
  private requester: Requester;

  constructor(config: PlaudConfig, requester: Requester = fetchRequester) {
    this.config = config;
    this.requester = requester;
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken();
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.accessToken;
    }
    return this.login();
  }

  /**
   * Drop the cached token and log in again. Callers use this to recover from a
   * 401 instead of proactively re-logging in, so we mint at most one new
   * session per actually-rejected token.
   */
  async refreshToken(): Promise<string> {
    return this.login();
  }

  async login(): Promise<string> {
    const creds = this.config.getCredentials();
    if (!creds) {
      throw new Error('No credentials configured. Run `plaud login` first.');
    }

    const baseUrl = BASE_URLS[creds.region] ?? BASE_URLS['us'];
    const body = new URLSearchParams({
      username: creds.email,
      password: creds.password,
    });

    const res = await this.requester({
      url: `${baseUrl}/auth/access-token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json() as {
      status: number;
      msg?: string;
      access_token: string;
      token_type: string;
    };

    if (data.status !== 0 || !data.access_token) {
      throw new Error(data.msg || `Login failed (status ${data.status})`);
    }

    const decoded = this.decodeJwtExpiry(data.access_token);
    const tokenData: PlaudTokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    };

    this.config.saveToken(tokenData);
    return data.access_token;
  }

  private isExpiringSoon(token: PlaudTokenData): boolean {
    // A token with no decodable expiry (expiresAt 0) is treated as expired.
    const lifetime = token.expiresAt - token.issuedAt;
    const buffer = lifetime > 0
      ? Math.min(MAX_REFRESH_BUFFER_MS, lifetime * REFRESH_BUFFER_FRACTION)
      : 0;
    return Date.now() + buffer > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}
