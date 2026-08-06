import * as zlib from 'node:zlib';
import { PlaudAuth } from './auth.js';
import { BASE_URLS } from './types.js';
import type { PlaudRecording, PlaudRecordingDetail, PlaudTranscriptSegment, PlaudUserInfo } from './types.js';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Plaud reports application-level failures as HTTP 200 with a negative `status`
 * in the body. Without this, a rejected credential reads as an empty account.
 *
 * Only reachable once BROWSER_UA is sent — without it the edge returns 403 and
 * `res.ok` catches the failure first.
 */
export class PlaudApiError extends Error {
  readonly status: number;

  constructor(status: number, msg?: string) {
    super(`Plaud API error ${status}${msg ? `: ${msg}` : ''}`);
    this.name = 'PlaudApiError';
    this.status = status;
  }

  /** Credential is missing, wrong, expired, or of the wrong type. */
  get isAuthFailure(): boolean {
    return this.status === -2 || this.status === -3901;
  }
}

export class PlaudClient {
  private auth: PlaudAuth;
  private region: string;

  constructor(auth: PlaudAuth, region: string = 'us') {
    this.auth = auth;
    this.region = region;
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us'];
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // Handle region mismatch
    if (data?.status === -302 && data?.data?.domains?.api) {
      const domain: string = data.data.domains.api;
      this.region = domain.includes('euc1') ? 'eu' : 'us';
      return this.request(path, options);
    }

    // Anything else non-zero is a failure the API chose to return as HTTP 200.
    if (typeof data?.status === 'number' && data.status !== 0) {
      throw new PlaudApiError(data.status, data.msg);
    }

    return data;
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web');
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter(r => !r.is_trash);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    let transcript = '';
    const preDownload: any[] = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? '';
      if (content.length > transcript.length) transcript = content;
    }

    // Fetch raw diarized transcript from content_list[data_type=transaction] (presigned S3 url, gzipped JSON).
    let rawTranscript: PlaudTranscriptSegment[] = [];
    const transactionItem = (raw.content_list ?? []).find((c: any) => c.data_type === 'transaction');
    if (transactionItem?.data_link) {
      try {
        const r = await fetch(transactionItem.data_link);
        if (!r.ok) {
          console.error(`[raw-transcript] HTTP ${r.status} for ${id}`);
        } else {
          const ab = await r.arrayBuffer();
          try {
            const buf = zlib.gunzipSync(Buffer.from(ab));
            rawTranscript = JSON.parse(buf.toString('utf8')) as PlaudTranscriptSegment[];
          } catch {
            // not gzipped — try raw JSON
            const text = Buffer.from(ab).toString('utf8');
            rawTranscript = JSON.parse(text) as PlaudTranscriptSegment[];
          }
        }
      } catch (e: any) {
        console.error(`[raw-transcript] error for ${id}:`, e?.message ?? e);
      }
    } else if (raw.content_list?.length) {
      console.error(`[raw-transcript] no transaction item for ${id}; types: ${raw.content_list.map((c: any) => c.data_type).join(',')}`);
    }
    const speakers = Array.from(new Set(rawTranscript.map(s => s.speaker).filter(Boolean)));

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript,
      rawTranscript,
      speakers,
    } as PlaudRecordingDetail;
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch {
      return null;
    }
  }
}
