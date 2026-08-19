import * as readline from 'readline';
import { PlaudConfig, PlaudAuth } from '@plaud/core';

export async function loginCommand(_args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    const email = await ask('Plaud email: ');
    const password = await ask('Password: ');
    const regionInput = await ask('Region (us/eu) [eu]: ');
    const region = (regionInput.trim() || 'eu') as 'us' | 'eu';

    const config = new PlaudConfig();
    config.saveCredentials({ email: email.trim(), password, region });

    console.log('Credentials saved. Verifying...');

    const auth = new PlaudAuth(config);
    const token = await auth.login();
    const stored = config.getToken();
    const days = stored
      ? Math.floor((stored.expiresAt - Date.now()) / (24 * 60 * 60 * 1000))
      : 0;
    console.log(`Login successful! Token valid for ~${days} days.`);
  } finally {
    rl.close();
  }
}
