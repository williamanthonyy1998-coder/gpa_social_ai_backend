import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, fail, ok } from '../../lib/http.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';

export const authRouter = Router();
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200), organizationSlug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9-]+$/).optional() });
const cookieOptions = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none', path: '/', maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000 };

authRouter.post('/login', asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid email and password.', parsed.error.flatten());
  const email = parsed.data.email.trim().toLowerCase();
  const candidates = await prisma.user.findMany({ where: { email, status: 'ACTIVE', organization: { status: 'ACTIVE', ...(parsed.data.organizationSlug ? { slug: parsed.data.organizationSlug } : {}) } }, take: 2 });
  if (!parsed.data.organizationSlug && candidates.length > 1) return fail(res, 400, 'ORGANIZATION_REQUIRED', 'Enter your workspace slug to continue.');
  const user = candidates[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await prisma.$transaction([
    prisma.userSession.create({ data: { userId: user.id, tokenHash, expiresAt } }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    prisma.auditLog.create({ data: { organizationId: user.organizationId, userId: user.id, entityType: 'UserSession', entityId: user.id, action: 'AUTH_LOGIN', ipAddress: req.ip, correlationId: res.locals.requestId } }),
  ]);
  res.cookie(env.SESSION_COOKIE_NAME, rawToken, cookieOptions);
  return ok(res, { user: { id: user.id, name: user.name, email: user.email }, expiresAt });
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const raw = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined;
  if (raw) {
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await prisma.userSession.updateMany({ where: { tokenHash, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    await prisma.auditLog.create({ data: { organizationId: req.auth!.organizationId, userId: req.auth!.userId, entityType: 'UserSession', entityId: req.auth!.userId, action: 'AUTH_LOGOUT', ipAddress: req.ip, correlationId: res.locals.requestId } });
  }
  res.clearCookie(env.SESSION_COOKIE_NAME, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none', path: '/' });
  return ok(res, { loggedOut: true });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, include: { roles: { include: { role: true } } } });
  if (!user) return fail(res, 404, 'USER_NOT_FOUND', 'User not found.');
  return ok(res, { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId, roles: user.roles.map(x => x.role.name), permissions: req.auth!.permissions });
}));
