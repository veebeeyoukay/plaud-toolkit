import * as fs from 'fs';
import * as path from 'path';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';
import type { PlaudTranscriptSegment } from '@plaud/core';

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatRawTranscript(segments: PlaudTranscriptSegment[]): string {
  if (!segments?.length) return '';
  const lines: string[] = [];
  let lastSpeaker = '';
  for (const seg of segments) {
    const sp = seg.speaker || seg.original_speaker || 'Speaker';
    const ts = formatTime(seg.start_time);
    if (sp !== lastSpeaker) {
      if (lines.length) lines.push('');
      lines.push(`**${sp}** [${ts}]`);
      lastSpeaker = sp;
    }
    lines.push(seg.content.trim());
  }
  return lines.join('\n');
}

export async function syncCommand(args: string[]): Promise<void> {
  const folder = args[0];
  if (!folder) {
    console.error('Usage: plaud sync <folder>');
    process.exit(1);
  }

  const force = args.includes('--force');
  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds?.region ?? 'eu');

  fs.mkdirSync(folder, { recursive: true });

  const recordings = await client.listRecordings();
  console.log(`Found ${recordings.length} recording(s).`);

  const untranscribed = recordings.filter(r => !r.is_trans);
  const transcribed = recordings.filter(r => r.is_trans);
  console.log(`  transcribed: ${transcribed.length}, untranscribed: ${untranscribed.length} (skipped)`);
  if (untranscribed.length) {
    console.log(`  → run 'plaud untranscribed' to list what's pending`);
  }

  let synced = 0;
  let updated = 0;
  for (const rec of transcribed) {
    const date = new Date(rec.start_time).toISOString().slice(0, 10);
    const slug = rec.filename?.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50) || rec.id;
    const mdFile = path.join(folder, `${date}_${slug}.md`);

    const exists = fs.existsSync(mdFile);
    if (exists && !force) continue;

    console.log(`${exists ? 'Re-syncing' : 'Syncing'}: ${rec.filename} (${rec.id})...`);
    const detail = await client.getRecording(rec.id);

    const rawMd = formatRawTranscript(detail.rawTranscript ?? []);
    const speakers = detail.speakers ?? [];

    const content = [
      '---',
      `plaud_id: ${rec.id}`,
      `title: "${rec.filename}"`,
      `date: ${date}`,
      `duration_minutes: ${Math.round(rec.duration / 60000)}`,
      `duration_ms: ${rec.duration}`,
      `start_time_ms: ${rec.start_time}`,
      `source: plaud`,
      `speakers: ${JSON.stringify(speakers)}`,
      `has_raw_transcript: ${rawMd.length > 0}`,
      `has_ai_summary: ${(detail.transcript ?? '').length > 0}`,
      '---',
      '',
      `# ${rec.filename}`,
      '',
      '## Raw Transcript',
      '',
      rawMd || '*(raw transcript not available in API response)*',
      '',
      '## AI Summary',
      '',
      detail.transcript || '*(no summary generated)*',
    ].join('\n');

    fs.writeFileSync(mdFile, content);
    if (exists) updated++; else synced++;
  }

  const parts: string[] = [];
  if (synced) parts.push(`${synced} new`);
  if (updated) parts.push(`${updated} re-synced`);
  if (untranscribed.length) parts.push(`${untranscribed.length} skipped (untranscribed)`);
  console.log(parts.length ? parts.join(', ') : 'Already up to date.');
}
