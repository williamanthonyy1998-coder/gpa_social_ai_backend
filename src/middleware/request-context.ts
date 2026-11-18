import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
export function requestContext(_req: Request, res: Response, next: NextFunction) {
  res.locals.requestId = randomUUID();
  res.setHeader('X-Request-Id', res.locals.requestId);
  next();
}
