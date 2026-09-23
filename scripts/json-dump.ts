#!/usr/bin/env npx tsx
// Machine-readable bridge for the call-producer: emits Plaud data as JSON.
//   json-dump.ts list           -> JSON array of recordings
//   json-dump.ts detail <id>    -> JSON recording detail (transcript + segments)
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

async function main() {
  const [cmd, id] = process.argv.slice(2);
  const config = new PlaudConfig();
  const creds = config.getCredentials();
  if (!creds) {
    console.error('No Plaud credentials found. Run `plaud login` first.');
    process.exit(1);
  }
  const client = new PlaudClient(new PlaudAuth(config), creds.region);
  if (cmd === 'list') {
    console.log(JSON.stringify(await client.listRecordings()));
  } else if (cmd === 'detail' && id) {
    console.log(JSON.stringify(await client.getRecording(id)));
  } else {
    console.error('usage: json-dump.ts list | detail <id>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
