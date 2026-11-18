CREATE TABLE "MediaAsset" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "uploadedById" UUID NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storagePath" TEXT NOT NULL,
  "altText" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SocialPostMedia" (
  "postId" UUID NOT NULL,
  "mediaAssetId" UUID NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SocialPostMedia_pkey" PRIMARY KEY ("postId", "mediaAssetId")
);
CREATE UNIQUE INDEX "MediaAsset_storagePath_key" ON "MediaAsset"("storagePath");
CREATE INDEX "MediaAsset_organizationId_createdAt_idx" ON "MediaAsset"("organizationId", "createdAt");
CREATE INDEX "SocialPostMedia_mediaAssetId_idx" ON "SocialPostMedia"("mediaAssetId");
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPostMedia" ADD CONSTRAINT "SocialPostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialPostMedia" ADD CONSTRAINT "SocialPostMedia_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
