import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, fail, ok } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePermission('audit.read'));
auditRouter.get('/', asyncHandler(async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30), userId: z.string().uuid().optional(), action: z.string().trim().max(80).optional() }).safeParse(req.query);
  if (!query.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid audit filters.', query.error.flatten());
  const { page, limit, userId, action } = query.data;
  const where = { organizationId: req.auth!.organizationId, ...(userId ? { userId } : {}), ...(action ? { action: { contains: action, mode: 'insensitive' as const } } : {}) };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' }, select: { id: true, userId: true, entityType: true, entityId: true, action: true, oldValue: true, newValue: true, ipAddress: true, correlationId: true, createdAt: true, user: { select: { name: true, email: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  return ok(res, { items, page, limit, total, pages: Math.ceil(total / limit) });
}));
