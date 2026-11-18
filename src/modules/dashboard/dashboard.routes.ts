import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, ok } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
export const dashboardRouter = Router();
dashboardRouter.get('/summary', requireAuth, asyncHandler(async (req, res) => {
  const [users, activeUsers, recentActivity, connectedAccounts] = await Promise.all([
    prisma.user.count({ where: { organizationId: req.auth!.organizationId } }),
    prisma.user.count({ where: { organizationId: req.auth!.organizationId, status: 'ACTIVE' } }),
    prisma.auditLog.findMany({ where: { organizationId: req.auth!.organizationId }, take: 8, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true, email: true } } } }),
    prisma.socialAccount.count({ where: { organizationId: req.auth!.organizationId, status: 'CONNECTED' } }),
  ]);
  return ok(res, { connectedAccounts, publishedPosts: null, pendingApprovals: null, scheduledPosts: null, publishingFailures: null, activeCampaigns: null, users, activeUsers, recentActivity });
}));
