import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, fail, ok } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { encryptToken } from '../../lib/token-vault.js';
import { refreshSocialAccount } from './token-lifecycle.js';

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

const platforms = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'TIKTOK', 'YOUTUBE', 'PINTEREST'] as const;

const accountSelect = {
  id: true, platform: true, accountName: true, handle: true, externalAccountId: true,
  profileUrl: true, status: true, tokenExpiresAt: true, scopes: true,
  lastVerifiedAt: true, lastRefreshAttemptAt: true, lastRefreshAt: true, lastError: true, createdAt: true, updatedAt: true,
} as const;

accountsRouter.get('/', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
  const rows = await prisma.socialAccount.findMany({
    where: { organizationId: req.auth!.organizationId },
    select: { ...accountSelect, refreshTokenCiphertext: true },
    orderBy: [{ platform: 'asc' }, { accountName: 'asc' }],
  });
  return ok(res, rows.map(({ refreshTokenCiphertext, ...row }) => ({ ...row, hasRefreshToken: Boolean(refreshTokenCiphertext) })));
}));

const createSchema = z.object({
  platform: z.enum(platforms),
  accountName: z.string().trim().min(2).max(120),
  handle: z.string().trim().max(120).optional().nullable(),
  externalAccountId: z.string().trim().max(200).optional().nullable(),
  profileUrl: z.string().url().max(500).optional().nullable(),
});

accountsRouter.post('/', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter valid social account details.', parsed.error.flatten());
  try {
    const row = await prisma.socialAccount.create({
      data: { ...parsed.data, organizationId: req.auth!.organizationId, status: 'PENDING' },
      select: accountSelect,
    });
    await prisma.auditLog.create({
      data: { organizationId: req.auth!.organizationId, userId: req.auth!.userId, entityType: 'SocialAccount', entityId: row.id, action: 'SOCIAL_ACCOUNT_REGISTERED', newValue: { platform: row.platform, accountName: row.accountName }, correlationId: res.locals.requestId },
    });
    return ok(res, row, 201);
  } catch (error: any) {
    if (error?.code === 'P2002') return fail(res, 409, 'ACCOUNT_EXISTS', 'This external account is already registered in this workspace.');
    throw error;
  }
}));

const credentialsSchema = z.object({
  accessToken: z.string().min(10).max(10000),
  refreshToken: z.string().min(10).max(10000).optional(),
  tokenExpiresAt: z.string().datetime().optional(),
  scopes: z.array(z.string().max(120)).max(100).default([]),
});

accountsRouter.put('/:id/credentials', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid credential payload.', parsed.error.flatten());
  const existing = await prisma.socialAccount.findFirst({ where: { id: String(req.params.id), organizationId: req.auth!.organizationId } });
  if (!existing) return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'Social account not found.');
  const updated = await prisma.socialAccount.update({
    where: { id: existing.id },
    data: {
      accessTokenCiphertext: encryptToken(parsed.data.accessToken),
      refreshTokenCiphertext: parsed.data.refreshToken ? encryptToken(parsed.data.refreshToken) : null,
      tokenExpiresAt: parsed.data.tokenExpiresAt ? new Date(parsed.data.tokenExpiresAt) : null,
      scopes: parsed.data.scopes,
      status: 'CONNECTED',
      lastVerifiedAt: new Date(),
      lastError: null,
    },
    select: accountSelect,
  });
  await prisma.auditLog.create({
    data: { organizationId: req.auth!.organizationId, userId: req.auth!.userId, entityType: 'SocialAccount', entityId: updated.id, action: 'SOCIAL_ACCOUNT_CREDENTIALS_SAVED', newValue: { platform: updated.platform, status: updated.status, scopes: updated.scopes }, correlationId: res.locals.requestId },
  });
  return ok(res, updated);
}));

const statusSchema = z.object({ status: z.enum(['PENDING', 'EXPIRED', 'ERROR', 'DISCONNECTED']) });
accountsRouter.patch('/:id/status', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid account status.', parsed.error.flatten());
  const existing = await prisma.socialAccount.findFirst({ where: { id: String(req.params.id), organizationId: req.auth!.organizationId } });
  if (!existing) return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'Social account not found.');
  const clearSecrets = parsed.data.status === 'DISCONNECTED';
  const updated = await prisma.socialAccount.update({
    where: { id: existing.id },
    data: { status: parsed.data.status, ...(clearSecrets ? { accessTokenCiphertext: null, refreshTokenCiphertext: null, tokenExpiresAt: null, scopes: [], refreshLeaseUntil: null } : {}) },
    select: accountSelect,
  });
  await prisma.auditLog.create({
    data: { organizationId: req.auth!.organizationId, userId: req.auth!.userId, entityType: 'SocialAccount', entityId: updated.id, action: clearSecrets ? 'SOCIAL_ACCOUNT_DISCONNECTED' : 'SOCIAL_ACCOUNT_STATUS_UPDATED', newValue: { status: updated.status }, correlationId: res.locals.requestId },
  });
  return ok(res, updated);
}));

accountsRouter.post('/:id/refresh', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  try {
    const refreshed = await refreshSocialAccount(String(req.params.id), req.auth!.organizationId);
    return ok(res, refreshed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to refresh this connection.';
    return fail(res, 409, 'TOKEN_REFRESH_FAILED', message);
  }
}));

accountsRouter.delete('/:id', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const existing = await prisma.socialAccount.findFirst({ where: { id: String(req.params.id), organizationId: req.auth!.organizationId } });
  if (!existing) return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'Social account not found.');
  await prisma.socialAccount.delete({ where: { id: existing.id } });
  await prisma.auditLog.create({
    data: { organizationId: req.auth!.organizationId, userId: req.auth!.userId, entityType: 'SocialAccount', entityId: existing.id, action: 'SOCIAL_ACCOUNT_REMOVED', oldValue: { platform: existing.platform, accountName: existing.accountName }, correlationId: res.locals.requestId },
  });
  return ok(res, { deleted: true });
}));
