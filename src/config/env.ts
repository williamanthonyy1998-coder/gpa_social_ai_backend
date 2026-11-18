import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(4000),
  // Browsers send Origin without a trailing slash; normalize so CORS matches.
  WEB_ORIGIN: z.string().url().default('http://localhost:5173').transform(v => v.replace(/\/$/, '')),
  SESSION_COOKIE_NAME: z.string().default('gpa_social_session'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
}).superRefine((value, ctx) => {
  if (value.COOKIE_SAME_SITE === 'none' && !value.COOKIE_SECURE) ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be true when COOKIE_SAME_SITE is none.' });
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
