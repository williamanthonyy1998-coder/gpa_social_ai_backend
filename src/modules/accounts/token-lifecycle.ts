import type { SocialAccount, SocialPlatform } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { decryptToken, encryptToken } from '../../lib/token-vault.js';
import { getOAuthConfig } from './oauth.config.js';

const EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;

function tokenPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const root = value as Record<string, unknown>;
  return root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
}

async function requestRefresh(account: SocialAccount): Promise<{ accessToken: string; refreshToken?: string; expiresAt: Date | null }> {
  const config = getOAuthConfig(account.platform as SocialPlatform);
  if (!config || !account.refreshTokenCiphertext) throw new Error('Refresh is not configured for this connection.');
  const refreshToken = decryptToken(account.refreshTokenCiphertext);
  const form = new URLSearchParams();
  const headers: Record<string, string> = { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };

  if (account.platform === 'FACEBOOK' || account.platform === 'INSTAGRAM') {
    // Meta long-lived user-token exchange is not the OAuth refresh_token grant.
    form.set('grant_type', 'fb_exchange_token');
    form.set('fb_exchange_token', refreshToken);
    form.set('client_id', config.clientId);
    form.set('client_secret', config.clientSecret);
  } else {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refreshToken);
    if (config.tokenAuth === 'body') {
      form.set(config.clientIdParam, config.clientId);
      form.set('client_secret', config.clientSecret);
    }
  }
  if (config.tokenAuth === 'basic' && account.platform !== 'FACEBOOK' && account.platform !== 'INSTAGRAM') {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }
  const tokenUrl = new URL(config.tokenUrl);
  const response = config.tokenMethod === 'GET'
    ? await fetch((tokenUrl.search = form.toString(), tokenUrl.toString()), { method: 'GET', headers, signal: AbortSignal.timeout(15000) })
    : await fetch(config.tokenUrl, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15000) });
  const payload = tokenPayload(await response.json().catch(() => ({})));
  if (!response.ok || typeof payload.access_token !== 'string') {
    const code = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
    throw new Error(`Provider rejected token refresh (${code}).`);
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : account.tokenExpiresAt,
  };
}

export async function refreshSocialAccount(accountId: string, organizationId?: string) {
  const account = await prisma.socialAccount.findFirst({ where: { id: accountId, ...(organizationId ? { organizationId } : {}) } });
  if (!account || account.status === 'DISCONNECTED') throw new Error('Connected social account not found.');
  if (!account.refreshTokenCiphertext) throw new Error('This provider connection has no refresh token; reconnect it when the access token expires.');
  const now = new Date();
  const claimed = await prisma.socialAccount.updateMany({
    where: { id: account.id, status: { in: ['CONNECTED', 'EXPIRED', 'ERROR'] }, OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }] },
    data: { refreshLeaseUntil: new Date(now.getTime() + LEASE_MS), lastRefreshAttemptAt: now },
  });
  if (claimed.count !== 1) throw new Error('A token refresh is already in progress for this account.');
  try {
    const result = await requestRefresh(account);
    const updated = await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        accessTokenCiphertext: encryptToken(result.accessToken),
        ...(result.refreshToken ? { refreshTokenCiphertext: encryptToken(result.refreshToken) } : {}),
        tokenExpiresAt: result.expiresAt,
        status: 'CONNECTED', lastVerifiedAt: new Date(), lastRefreshAt: new Date(), lastError: null, refreshLeaseUntil: null,
      },
      select: { id: true, organizationId: true, platform: true, accountName: true, status: true, tokenExpiresAt: true, lastRefreshAt: true },
    });
    await prisma.auditLog.create({ data: { organizationId: account.organizationId, entityType: 'SocialAccount', entityId: account.id, action: 'SOCIAL_TOKEN_REFRESHED', newValue: { platform: account.platform, tokenExpiresAt: result.expiresAt?.toISOString() ?? null } } });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Token refresh failed.';
    await prisma.socialAccount.update({ where: { id: account.id }, data: { status: 'ERROR', lastError: message, refreshLeaseUntil: null } });
    await prisma.auditLog.create({ data: { organizationId: account.organizationId, entityType: 'SocialAccount', entityId: account.id, action: 'SOCIAL_TOKEN_REFRESH_FAILED', newValue: { platform: account.platform, reason: message } } });
    throw error;
  }
}

export async function runTokenLifecycleSweep() {
  const now = new Date();
  const due = await prisma.socialAccount.findMany({
    where: { status: 'CONNECTED', tokenExpiresAt: { lte: new Date(now.getTime() + EXPIRY_BUFFER_MS) }, refreshTokenCiphertext: { not: null } },
    select: { id: true, organizationId: true }, take: 50,
  });
  for (const item of due) {
    try { await refreshSocialAccount(item.id, item.organizationId); }
    catch (error) { console.warn('Scheduled social token refresh did not complete:', error instanceof Error ? error.message : 'unknown error'); }
  }
  await prisma.socialAccount.updateMany({
    where: { status: 'CONNECTED', tokenExpiresAt: { lte: now }, refreshTokenCiphertext: null },
    data: { status: 'EXPIRED', lastError: 'Access token expired; reconnect this social account.' },
  });
}
