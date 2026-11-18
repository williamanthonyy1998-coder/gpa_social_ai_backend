CREATE TYPE "PublishJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TABLE "PublishJob" (
  "id" UUID NOT NULL, "targetId" UUID NOT NULL, "organizationId" UUID NOT NULL,
  "status" "PublishJobStatus" NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3), "providerPostId" TEXT, "lastError" TEXT, "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublishJob_targetId_key" ON "PublishJob"("targetId");
CREATE INDEX "PublishJob_status_nextAttemptAt_idx" ON "PublishJob"("status", "nextAttemptAt");
CREATE INDEX "PublishJob_organizationId_createdAt_idx" ON "PublishJob"("organizationId", "createdAt");
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "SocialPostTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
