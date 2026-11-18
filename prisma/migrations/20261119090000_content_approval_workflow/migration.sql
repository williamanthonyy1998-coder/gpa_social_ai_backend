CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','SCHEDULED','PUBLISHING','PUBLISHED','FAILED','CANCELLED');
CREATE TABLE "SocialPost" (
  "id" UUID NOT NULL, "organizationId" UUID NOT NULL, "createdById" UUID NOT NULL,
  "title" TEXT NOT NULL, "body" TEXT NOT NULL, "status" "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduledAt" TIMESTAMP(3), "submittedAt" TIMESTAMP(3), "approvedAt" TIMESTAMP(3), "approvedById" UUID,
  "publishedAt" TIMESTAMP(3), "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "SocialPostTarget" (
  "id" UUID NOT NULL, "postId" UUID NOT NULL, "socialAccountId" UUID NOT NULL,
  "platformStatus" TEXT NOT NULL DEFAULT 'PENDING', "providerPostId" TEXT, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialPostTarget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPostTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialPostTarget_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "SocialPostApproval" (
  "id" UUID NOT NULL, "postId" UUID NOT NULL, "reviewerId" UUID NOT NULL,
  "decision" TEXT NOT NULL, "comment" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPostApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPostApproval_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SocialPostTarget_postId_socialAccountId_key" ON "SocialPostTarget"("postId","socialAccountId");
CREATE INDEX "SocialPost_organizationId_status_scheduledAt_idx" ON "SocialPost"("organizationId","status","scheduledAt");
CREATE INDEX "SocialPost_organizationId_createdAt_idx" ON "SocialPost"("organizationId","createdAt");
CREATE INDEX "SocialPostTarget_socialAccountId_idx" ON "SocialPostTarget"("socialAccountId");
CREATE INDEX "SocialPostApproval_postId_createdAt_idx" ON "SocialPostApproval"("postId","createdAt");
