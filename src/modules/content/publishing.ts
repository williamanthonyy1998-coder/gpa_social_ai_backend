import { prisma } from '../../lib/prisma.js';
import { decryptToken } from '../../lib/token-vault.js';

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION ?? '';
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function messageFrom(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const err = (value as any).error;
    return String(err?.message ?? 'Provider rejected the publishing request.').slice(0, 1500);
  }
  return 'Provider publishing failed.';
}

async function publishFacebookPage(job: any): Promise<string> {
  const account = job.target.socialAccount;
  const metadata = account.metadata && typeof account.metadata === 'object' ? account.metadata as Record<string, unknown> : {};
  if (metadata.assetType !== 'FACEBOOK_PAGE') throw new Error('FACEBOOK_PAGE_REQUIRED: Select a Facebook Page asset before publishing.');
  if (!account.externalAccountId || !account.accessTokenCiphertext) throw new Error('ACCOUNT_CREDENTIALS_MISSING: Reconnect this Facebook Page.');
  if (!/^v\d+\.\d+$/.test(GRAPH_VERSION)) throw new Error('META_GRAPH_API_VERSION is not configured to a supported version.');
  const token = decryptToken(account.accessTokenCiphertext);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(account.externalAccountId)}/feed`;
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ message: job.target.post.body, access_token: token }) });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) throw new Error(messageFrom(payload));
  return String(payload.id);
}

async function deliver(job: any): Promise<string> {
  const platform = job.target.socialAccount.platform;
  if (platform === 'FACEBOOK') return publishFacebookPage(job);
  if (platform === 'INSTAGRAM') throw new Error('MEDIA_REQUIRED: Instagram publishing requires an approved image or video asset; text-only publishing is not supported.');
  throw new Error(`ADAPTER_NOT_CONFIGURED: Publishing adapter for ${platform} is not enabled in this release.`);
}

export async function runPublishingSweep() {
  const now = new Date();
  const candidates = await prisma.publishJob.findMany({
    where: { status: { in: ['QUEUED', 'RETRY_WAIT', 'PROCESSING'] }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    select: { id: true }, orderBy: { nextAttemptAt: 'asc' }, take: 10,
  });
  for (const candidate of candidates) {
    const lease = await prisma.publishJob.updateMany({ where: { id: candidate.id, status: { in: ['QUEUED', 'RETRY_WAIT', 'PROCESSING'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { status: 'PROCESSING', leaseUntil: new Date(Date.now() + 120_000), startedAt: new Date() } });
    if (!lease.count) continue;
    const job: any = await prisma.publishJob.findUnique({ where: { id: candidate.id }, include: { target: { include: { post: true, socialAccount: true } } } });
    if (!job) continue;
    try {
      if (job.target.post.status !== 'SCHEDULED' && job.target.post.status !== 'PUBLISHING') throw new Error('POST_NOT_SCHEDULED: Post is no longer scheduled.');
      if (job.target.socialAccount.status !== 'CONNECTED') throw new Error('ACCOUNT_NOT_CONNECTED: Reconnect the target account.');
      const providerPostId = await deliver(job);
      await prisma.$transaction([
        prisma.publishJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', providerPostId, attempts: { increment: 1 }, leaseUntil: null, lastError: null, completedAt: new Date() } }),
        prisma.socialPostTarget.update({ where: { id: job.targetId }, data: { platformStatus: 'PUBLISHED', providerPostId, error: null } }),
      ]);
      const targetStates = await prisma.socialPostTarget.findMany({ where: { postId: job.target.postId }, select: { platformStatus: true } });
      if (targetStates.length && targetStates.every((t) => t.platformStatus === 'PUBLISHED')) await prisma.socialPost.update({ where: { id: job.target.postId }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      else await prisma.socialPost.updateMany({ where: { id: job.target.postId, status: 'SCHEDULED' }, data: { status: 'PUBLISHING' } });
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = error instanceof Error ? error.message : 'Unknown publishing error.';
      const permanent = /ADAPTER_NOT_CONFIGURED|MEDIA_REQUIRED|FACEBOOK_PAGE_REQUIRED|ACCOUNT_CREDENTIALS_MISSING|POST_NOT_SCHEDULED/.test(message);
      const failed = permanent || attempts >= job.maxAttempts;
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
      await prisma.$transaction([
        prisma.publishJob.update({ where: { id: job.id }, data: { status: failed ? 'FAILED' : 'RETRY_WAIT', attempts, nextAttemptAt: new Date(Date.now() + delay), leaseUntil: null, lastError: message } }),
        prisma.socialPostTarget.update({ where: { id: job.targetId }, data: { platformStatus: failed ? 'FAILED' : 'RETRY_WAIT', error: message } }),
      ]);
      if (failed) {
        const states = await prisma.socialPostTarget.findMany({ where: { postId: job.target.postId }, select: { platformStatus: true } });
        if (states.length && states.every((t) => ['PUBLISHED', 'FAILED', 'CANCELLED'].includes(t.platformStatus))) {
          await prisma.socialPost.update({ where: { id: job.target.postId }, data: { status: 'FAILED', lastError: message } });
        }
      }
    }
  }
  const remaining = await prisma.publishJob.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'RETRY_WAIT'] } } });
  const succeeded = await prisma.publishJob.count({ where: { status: 'SUCCEEDED' } });
  const failed = await prisma.publishJob.count({ where: { status: 'FAILED' } });
  return { processed: candidates.length, remaining, succeeded, failed };
}
