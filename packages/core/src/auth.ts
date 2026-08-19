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

    // Token-only mode: no password to exchange, so there is nothing to refresh.
    // Keep using the token until it is genuinely expired, then say exactly what
    // the user has to do. Never minting a session here is the point — it is
    // also why token-only mode leaves the phone app's session alone entirely.
    if (!this.canLogin()) {
      if (cached && !this.isExpired(cached)) {
        return cached.accessToken;
      }
      throw new Error(this.tokenOnlyError(cached));
    }

    return this.login();
  }

  /** True when a password is stored, i.e. a token can be minted on demand. */
  canLogin(): boolean {
    return !!this.config.getCredentials()?.password;
  }

  /**
   * True when this install can reach the API at all: either it can log in, or
   * it holds a token that has not expired yet. Hosts use this to decide whether
   * they are configured (a token-only install has no credentials to check).
   */
  isUsable(): boolean {
    if (this.canLogin()) return true;
    const token = this.config.getToken();
    return !!token && !this.isExpired(token);
  }

  /**
   * The region to talk to. Taken from stored credentials, else from the token's
   * own `region` claim (token-only installs have no credentials to read), else
   * 'us' — the client still self-corrects on a -302 region mismatch.
   */
  getRegion(): 'us' | 'eu' {
    const creds = this.config.getCredentials();
    if (creds?.region) return creds.region;

    const token = this.config.getToken();
    if (token) {
      try {
        const claim = this.decodeClaims(token.accessToken).region;
        if (typeof claim === 'string' && claim.includes('eu-')) return 'eu';
        if (typeof claim === 'string') return 'us';
      } catch {
        // Unreadable token — fall through to the default.
      }
    }
    return 'us';
  }

  /**
   * Drop the cached token and log in again. Callers use this to recover from a
   * 401 instead of proactively re-logging in, so we mint at most one new
   * session per actually-rejected token. In token-only mode there is nothing to
   * refresh with, so a rejected token is a dead end the user must resolve.
   */
  async refreshToken(): Promise<string> {
    if (!this.canLogin()) {
      throw new Error(this.tokenOnlyError(this.config.getToken()));
    }
    return this.login();
  }

  async login(): Promise<string> {
    const creds = this.config.getCredentials();
    if (!creds) {
      throw new Error('No credentials configured. Run `plaud login` first.');
    }
    if (!creds.password) {
      throw new Error(
        `No password stored for ${creds.email}, so a token cannot be minted. ` +
        'Paste a fresh token into ~/.plaud/config.json, or run `plaud login` to store a password.'
      );
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

  private isExpired(token: PlaudTokenData): boolean {
    return Date.now() >= token.expiresAt;
  }

  private tokenOnlyError(token?: PlaudTokenData): string {
    const what = token ? 'Your Plaud token has expired' : 'No Plaud token found';
    return `${what} and no password is stored to mint a new one. ` +
      'Extract a fresh token from web.plaud.ai (localStorage) into ~/.plaud/config.json, ' +
      'or run `plaud login` to store a password for automatic refresh.';
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
    const payload = this.decodeClaims(jwt);
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }

  private decodeClaims(jwt: string): Record<string, any> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  }
}
