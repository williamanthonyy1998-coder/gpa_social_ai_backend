import type { Request, Response, NextFunction } from 'express';
export function ok(res: Response, data: unknown, status = 200) {
  return res.status(status).json({ success: true, data, meta: { requestId: res.locals.requestId } });
}
export function fail(res: Response, status: number, code: string, message: string, details?: unknown) {
  return res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) }, meta: { requestId: res.locals.requestId } });
}
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);
}
