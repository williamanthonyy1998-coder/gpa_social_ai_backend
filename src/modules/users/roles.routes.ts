import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

export const rolesRouter = Router();
rolesRouter.use(requireAuth);
rolesRouter.get('/', requirePermission('roles.read'), asyncHandler(async (req, res) => {
  const roles = await prisma.role.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, description: true, isSystem: true, _count: { select: { users: true } }, permissions: { select: { permission: { select: { key: true, module: true, action: true } } } } },
  });
  return ok(res, roles.map(role => ({ ...role, permissions: role.permissions.map(item => item.permission) })));
}));
