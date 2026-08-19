import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudAuth', () => {
  let tmpDir: string;
  let config: PlaudConfig;
  let auth: PlaudAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-auth-'));
    config = new PlaudConfig(tmpDir);
    config.saveCredentials({ email: 'test@plaud.ai', password: 'pass123', region: 'eu' });
    auth = new PlaudAuth(config);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs in with email+password and stores token', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);

    const stored = config.getToken();
    expect(stored?.accessToken).toBe(fakeToken);
  });

  it('returns cached token when still valid', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: fakeToken,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes token when expired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 1000;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: pastExp, iat: pastExp - 86400 })).toString('base64url');
    const expiredToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: expiredToken,
      tokenType: 'Bearer',
      issuedAt: (pastExp - 86400) * 1000,
      expiresAt: pastExp * 1000,
    });

    const newExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const newPayload = Buffer.from(JSON.stringify({ sub: 'abc', exp: newExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const newToken = `eyJhbGciOiJIUzI1NiJ9.${newPayload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: newToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(newToken);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('reuses a freshly issued 30-day token instead of logging in again', async () => {
    // Regression: the refresh buffer was a flat 30 days while Plaud issues
    // 30-day tokens, so every request re-logged in — minting a new Plaud
    // session each time and kicking the phone app off the account.
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 30 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp, iat })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: fakeToken,
      tokenType: 'bearer',
      issuedAt: iat * 1000,
      expiresAt: exp * 1000,
    });

    expect(await auth.getToken()).toBe(fakeToken);
    expect(await auth.getToken()).toBe(fakeToken);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes a 30-day token once it is within hours of expiry', async () => {
    const iat = Math.floor(Date.now() / 1000) - 30 * 86400 + 600;
    const exp = iat + 30 * 86400; // 10 minutes left
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp, iat })).toString('base64url');
    const stale = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: stale,
      tokenType: 'bearer',
      issuedAt: iat * 1000,
      expiresAt: exp * 1000,
    });

    const newIat = Math.floor(Date.now() / 1000);
    const newPayload = Buffer.from(JSON.stringify({ sub: 'abc', exp: newIat + 30 * 86400, iat: newIat })).toString('base64url');
    const fresh = `eyJhbGciOiJIUzI1NiJ9.${newPayload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: fresh, token_type: 'bearer' }),
    });

    expect(await auth.getToken()).toBe(fresh);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws actionable guidance when neither credentials nor token exist', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-empty-'));
    const emptyConfig = new PlaudConfig(emptyDir);
    const emptyAuth = new PlaudAuth(emptyConfig);

    await expect(emptyAuth.getToken()).rejects.toThrow('No Plaud token found');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('throws on wrong credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -2, msg: 'wrong account or password', access_token: '' }),
    });

    await expect(auth.getToken()).rejects.toThrow('wrong account or password');
  });
  // --- Token-only mode (no password stored, e.g. Google Sign-In users) ---
  describe('token-only mode', () => {
    let tokenDir: string;
    let tokenConfig: PlaudConfig;
    let tokenAuth: PlaudAuth;

    const makeToken = (iat: number, exp: number, region = 'aws:eu-central-1') => {
      const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp, iat, region })).toString('base64url');
      return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    };

    beforeEach(() => {
      tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-token-'));
      tokenConfig = new PlaudConfig(tokenDir);
      tokenAuth = new PlaudAuth(tokenConfig);
    });

    afterEach(() => {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    });

    it('serves a pasted token and never logs in', async () => {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + 30 * 86400;
      const token = makeToken(iat, exp);
      tokenConfig.saveToken({ accessToken: token, tokenType: 'bearer', issuedAt: iat * 1000, expiresAt: exp * 1000 });

      expect(await tokenAuth.getToken()).toBe(token);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps using a near-expiry token instead of minting a session', async () => {
      // With a password this would refresh; token-only mode has nothing to
      // refresh with, so the still-valid token is used rather than failing.
      const iat = Math.floor(Date.now() / 1000) - 30 * 86400 + 600;
      const exp = iat + 30 * 86400; // 10 minutes left
      const token = makeToken(iat, exp);
      tokenConfig.saveToken({ accessToken: token, tokenType: 'bearer', issuedAt: iat * 1000, expiresAt: exp * 1000 });

      expect(await tokenAuth.getToken()).toBe(token);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws actionable guidance once the token is expired', async () => {
      const exp = Math.floor(Date.now() / 1000) - 1000;
      const token = makeToken(exp - 86400, exp);
      tokenConfig.saveToken({ accessToken: token, tokenType: 'bearer', issuedAt: (exp - 86400) * 1000, expiresAt: exp * 1000 });

      await expect(tokenAuth.getToken()).rejects.toThrow('Your Plaud token has expired');
      await expect(tokenAuth.refreshToken()).rejects.toThrow('web.plaud.ai');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports usability and infers the region from the token claim', () => {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + 30 * 86400;
      expect(tokenAuth.isUsable()).toBe(false);
      expect(tokenAuth.canLogin()).toBe(false);
      expect(tokenAuth.getRegion()).toBe('us'); // no credentials, no token

      tokenConfig.saveToken({ accessToken: makeToken(iat, exp), tokenType: 'bearer', issuedAt: iat * 1000, expiresAt: exp * 1000 });
      expect(tokenAuth.isUsable()).toBe(true);
      expect(tokenAuth.getRegion()).toBe('eu');

      tokenConfig.saveToken({ accessToken: makeToken(iat, exp, 'aws:us-east-1'), tokenType: 'bearer', issuedAt: iat * 1000, expiresAt: exp * 1000 });
      expect(tokenAuth.getRegion()).toBe('us');
    });

    it('explains itself when credentials exist without a password', async () => {
      tokenConfig.saveCredentials({ email: 'google@plaud.ai', region: 'eu' });
      await expect(tokenAuth.login()).rejects.toThrow('No password stored for google@plaud.ai');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
