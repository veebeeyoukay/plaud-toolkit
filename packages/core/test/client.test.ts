import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudClient, PlaudApiError } from '../src/client.js';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudClient', () => {
  let tmpDir: string;
  let client: PlaudClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-client-'));
    const config = new PlaudConfig(tmpDir);
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    config.saveCredentials({ email: 't@t.com', password: 'p', region: 'eu' });
    config.saveToken({
      accessToken: token,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });
    const auth = new PlaudAuth(config);
    client = new PlaudClient(auth, 'eu');
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists recordings', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [
          { id: 'rec1', filename: 'Test', is_trash: false },
          { id: 'rec2', filename: 'Trash', is_trash: true },
        ],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('rec1');
  });

  it('gets recording detail with transcript', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data: {
          file_id: 'rec1',
          file_name: 'Meeting',
          pre_download_content_list: [
            { data_content: 'Short' },
            { data_content: 'This is the full transcript of the meeting.' },
          ],
        },
      }),
    });

    const detail = await client.getRecording('rec1');
    expect(detail.transcript).toBe('This is the full transcript of the meeting.');
  });

  it('gets user info', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_user: { id: 'u1', nickname: 'Sergi', email: 'test@plaud.ai', country: 'ES', membership_type: 'starter' },
      }),
    });

    const user = await client.getUserInfo();
    expect(user.nickname).toBe('Sergi');
  });

  it('throws on an app-level error returned as HTTP 200', async () => {
    // The exact shape a rejected token produced against /file/simple/web on 2026-07-31.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -3901, msg: 'token type does not match parse mode' }),
    });

    await expect(client.listRecordings()).rejects.toThrow(PlaudApiError);
  });

  it('does not report a rejected credential as an empty account', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -3901, msg: 'token type does not match parse mode' }),
    });

    // The regression: this used to resolve to [] and read as "no recordings".
    const err = await client.listRecordings().catch(e => e);
    expect(err).toBeInstanceOf(PlaudApiError);
    expect(err.status).toBe(-3901);
    expect(err.isAuthFailure).toBe(true);
    expect(err.message).toContain('token type does not match parse mode');
  });

  it('flags a wrong password as an auth failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -2, msg: 'wrong account or password' }),
    });

    const err = await client.getUserInfo().catch(e => e);
    expect(err).toBeInstanceOf(PlaudApiError);
    expect(err.isAuthFailure).toBe(true);
  });

  it('does not flag a non-auth error as an auth failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -1234, msg: 'something else' }),
    });

    const err = await client.listRecordings().catch(e => e);
    expect(err).toBeInstanceOf(PlaudApiError);
    expect(err.isAuthFailure).toBe(false);
  });

  it('leaves a genuinely empty account as an empty list', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, data_file_list: [] }),
    });

    // The distinction the whole change exists to preserve.
    await expect(client.listRecordings()).resolves.toEqual([]);
  });

  it('handles region mismatch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: -302,
        data: { domains: { api: 'api-euc1.plaud.ai' } },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [{ id: 'rec1', filename: 'Test', is_trash: false }],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
