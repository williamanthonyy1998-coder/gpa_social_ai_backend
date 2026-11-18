ALTER TABLE "SocialAccount"
  ADD COLUMN "lastRefreshAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastRefreshAt" TIMESTAMP(3),
  ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3);

CREATE INDEX "SocialAccount_tokenExpiresAt_idx" ON "SocialAccount"("tokenExpiresAt");
CREATE INDEX "SocialAccount_refreshLeaseUntil_idx" ON "SocialAccount"("refreshLeaseUntil");
