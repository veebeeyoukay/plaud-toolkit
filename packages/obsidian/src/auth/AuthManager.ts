import { Notice } from 'obsidian';
import { PlaudAuth, PlaudConfig } from '@plaud/core';
import type PlaudPlugin from '../../main';

/**
 * AuthManager — delegates to @plaud/core for automatic token management.
 * Plaud tokens currently last ~30 days; the cached token is reused until it is
 * nearly expired (see @plaud/core's PlaudAuth) because every password login
 * mints a new Plaud session and evicts the one the phone app is holding.
 * Credentials are stored in ~/.plaud/config.json (shared with plaud-cli).
 */
export class AuthManager {
  private auth: PlaudAuth;
  private config: PlaudConfig;

  constructor(private plugin: PlaudPlugin) {
    this.config = new PlaudConfig();
    this.auth = new PlaudAuth(this.config);
  }

  /**
   * Returns a valid token, auto-refreshing if needed.
   * Throws if no credentials are configured.
   */
  async ensureToken(): Promise<string> {
    return this.auth.getToken();
  }

  /**
   * Whether the plugin can talk to Plaud: either a password is stored (token
   * auto-refresh) or an unexpired token is present (token-only mode, e.g.
   * Google Sign-In users, who have no credentials to check).
   */
  isConfigured(): boolean {
    return this.auth.isUsable();
  }

  /** Get the stored email (for display in settings). */
  getEmail(): string | undefined {
    return this.config.getCredentials()?.email;
  }

  /** Get the region, inferred from the token when there are no credentials. */
  getRegion(): string {
    return this.auth.getRegion();
  }

  /** Whether we are running off a pasted token with no password to refresh it. */
  isTokenOnly(): boolean {
    return !this.auth.canLogin();
  }

  /** How much time remains on the cached token. */
  tokenStatus(): string {
    const token = this.config.getToken();
    if (!token) return 'no token';
    const remaining = token.expiresAt - Date.now();
    if (remaining <= 0) return 'expired';
    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    return `${days} days remaining`;
  }
}
