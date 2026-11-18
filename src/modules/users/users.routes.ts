import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, fail, ok } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { env } from '../../config/env.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);
usersRouter.get('/', requirePermission('users.read'), asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({ where: { organizationId: req.auth!.organizationId }, select: { id: true, name: true, email: true, status: true, lastLoginAt: true, createdAt: true, roles: { include: { role: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' } });
  return ok(res, users);
}));
const createSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(254), password: z.string().min(12).max(200), roleIds: z.array(z.string().uuid()).default([]) });
usersRouter.post('/', requirePermission('users.create'), asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid user details.', parsed.error.flatten());
  const { name, email, password, roleIds } = parsed.data;
  const orgId = req.auth!.organizationId;
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds }, organizationId: orgId }, select: { id: true } });
  if (roles.length !== new Set(roleIds).size) return fail(res, 400, 'INVALID_ROLES', 'One or more roles are invalid for this organization.');
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  try {
    const user = await prisma.user.create({ data: { organizationId: orgId, name, email: email.toLowerCase(), passwordHash, roles: { create: roles.map(r => ({ roleId: r.id, assignedBy: req.auth!.userId })) } }, select: { id: true, name: true, email: true, status: true, createdAt: true } });
    await prisma.auditLog.create({ data: { organizationId: orgId, userId: req.auth!.userId, entityType: 'User', entityId: user.id, action: 'USER_CREATED', newValue: { name, email: email.toLowerCase() }, correlationId: res.locals.requestId } });
    return ok(res, user, 201);
  } catch (e: any) { if (e?.code === 'P2002') return fail(res, 409, 'EMAIL_EXISTS', 'A user with this email already exists.'); throw e; }
}));
const updateSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(), roleIds: z.array(z.string().uuid()).optional() }).refine(v => Object.keys(v).length > 0);
usersRouter.patch('/:id', requirePermission('users.update'), asyncHandler(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid update.', parsed.error.flatten());
  const orgId = req.auth!.organizationId;
  const existing = await prisma.user.findFirst({ where: { id:  String(req.params.id), organizationId: orgId } });
  if (!existing) return fail(res, 404, 'USER_NOT_FOUND', 'User not found.');
  if (existing.id === req.auth!.userId && parsed.data.status && parsed.data.status !== 'ACTIVE') return fail(res, 400, 'SELF_SUSPENSION_BLOCKED', 'You cannot suspend your own active session account.');
  const { roleIds, ...profileData } = parsed.data;
  if (roleIds) {
    const validRoles = await prisma.role.findMany({ where: { id: { in: roleIds }, organizationId: orgId }, select: { id: true } });
    if (validRoles.length !== new Set(roleIds).size) return fail(res, 400, 'INVALID_ROLES', 'One or more roles are invalid for this organization.');
    if (existing.id === req.auth!.userId && !roleIds.length) return fail(res, 400, 'SELF_ROLE_REMOVAL_BLOCKED', 'You cannot remove all roles from your own account.');
  }
  const user = await prisma.$transaction(async tx => {
    const updated = await tx.user.update({ where: { id: existing.id }, data: { ...profileData, ...(roleIds ? { roles: { deleteMany: {}, create: roleIds.map(roleId => ({ roleId, assignedBy: req.auth!.userId })) } } : {}) }, select: { id: true, name: true, email: true, status: true, updatedAt: true } });
    if (roleIds) await tx.auditLog.create({ data: { organizationId: orgId, userId: req.auth!.userId, entityType: 'UserRole', entityId: existing.id, action: 'USER_ROLES_UPDATED', newValue: { roleIds }, correlationId: res.locals.requestId } });
    return updated;
  });
  if (parsed.data.status && parsed.data.status !== 'ACTIVE') await prisma.userSession.updateMany({ where: { userId: user.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
  await prisma.auditLog.create({ data: { organizationId: orgId, userId: req.auth!.userId, entityType: 'User', entityId: user.id, action: 'USER_UPDATED', oldValue: { name: existing.name, status: existing.status }, newValue: { ...profileData, ...(roleIds ? { roleIds } : {}) }, correlationId: res.locals.requestId } });
  return ok(res, user);
}));
