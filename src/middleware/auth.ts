
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { fail } from '../lib/http.js';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        organizationId: string;
        name: string;
        email: string;
        permissions: string[];
        roles: string[];
      };
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const raw = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined;

    if (!raw) {
      return fail(res, 401, 'UNAUTHENTICATED', 'Please sign in.');
    }

    const tokenHash = createHash('sha256')
      .update(raw)
      .digest('hex');

    const session = await prisma.userSession.findUnique({
      where: {
        tokenHash,
      },
      include: {
        user: {
          include: {
            organization: true,
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: {
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (
      !session ||
      session.status !== 'ACTIVE' ||
      session.expiresAt <= new Date() ||
      session.user.status !== 'ACTIVE' ||
      session.user.organization.status !== 'ACTIVE'
    ) {
      return fail(
        res,
        401,
        'SESSION_INVALID',
        'Your session is invalid or expired.'
      );
    }

    const permissions = new Set<string>();

    const roles = session.user.roles.map(
      (ur) => ur.role.name
    );

    for (const ur of session.user.roles) {
      for (const rp of ur.role.permissions) {
        permissions.add(rp.permission.key);
      }
    }

    req.auth = {
      userId: session.user.id,
      organizationId: session.user.organizationId,
      name: session.user.name,
      email: session.user.email,
      permissions: [...permissions],
      roles,
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(permission: string) {
  return (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.auth?.permissions.includes(permission)) {
      return fail(
        res,
        403,
        'FORBIDDEN',
        'You do not have permission to perform this action.'
      );
    }

    next();
  };
}
