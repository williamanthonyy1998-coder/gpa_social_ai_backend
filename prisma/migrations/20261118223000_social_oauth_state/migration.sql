CREATE TABLE "SocialOAuthState" (
  "id" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "codeVerifier" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialOAuthState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialOAuthState_stateHash_key" ON "SocialOAuthState"("stateHash");
CREATE INDEX "SocialOAuthState_expiresAt_idx" ON "SocialOAuthState"("expiresAt");
CREATE INDEX "SocialOAuthState_organizationId_platform_idx" ON "SocialOAuthState"("organizationId", "platform");
