-- Phase 2: organization-scoped social account registry and encrypted credential storage.
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'TIKTOK', 'YOUTUBE', 'PINTEREST');
CREATE TYPE "SocialAccountStatus" AS ENUM ('PENDING', 'CONNECTED', 'EXPIRED', 'ERROR', 'DISCONNECTED');

CREATE TABLE "SocialAccount" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "accountName" TEXT NOT NULL,
    "handle" TEXT,
    "externalAccountId" TEXT,
    "profileUrl" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'PENDING',
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SocialAccount_organizationId_status_idx" ON "SocialAccount"("organizationId", "status");
CREATE INDEX "SocialAccount_organizationId_platform_idx" ON "SocialAccount"("organizationId", "platform");
CREATE UNIQUE INDEX "SocialAccount_organizationId_platform_externalAccountId_key" ON "SocialAccount"("organizationId", "platform", "externalAccountId");
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
