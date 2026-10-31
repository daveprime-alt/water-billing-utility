ALTER TYPE "SmsStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "SmsStatus" ADD VALUE 'CANCELLED';

CREATE TYPE "SmsCampaignStatus" AS ENUM (
    'DRAFT',
    'QUEUED',
    'SENDING',
    'PAUSED',
    'COMPLETED'
);

ALTER TABLE "User"
    ADD COLUMN "smsAnnouncementsOptOutAt" TIMESTAMP(3);

ALTER TABLE "SMSQueue"
    ADD COLUMN "notificationType" TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN "templateData" JSONB,
    ADD COLUMN "deduplicationKey" TEXT,
    ADD COLUMN "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "lockedAt" TIMESTAMP(3),
    ADD COLUMN "sentAt" TIMESTAMP(3),
    ADD COLUMN "failedAt" TIMESTAMP(3),
    ADD COLUMN "cancelledAt" TIMESTAMP(3),
    ADD COLUMN "providerMessageId" TEXT,
    ADD COLUMN "manualRetryCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "deliveryCycle" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "campaignId" TEXT;

CREATE TABLE "SMSAttempt" (
    "id" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "deliveryCycle" INTEGER NOT NULL DEFAULT 0,
    "accepted" BOOLEAN NOT NULL,
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SMSAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SMSCampaign" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SmsCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "previewedRecipientCount" INTEGER,
    "previewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "SMSCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SMSAdminAudit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SMSAdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SMSQueue_deduplicationKey_key"
    ON "SMSQueue"("deduplicationKey");
CREATE INDEX "SMSQueue_status_nextAttemptAt_scheduledAt_idx"
    ON "SMSQueue"("status", "nextAttemptAt", "scheduledAt");
CREATE INDEX "SMSQueue_campaignId_status_idx"
    ON "SMSQueue"("campaignId", "status");
CREATE INDEX "SMSAttempt_queueId_createdAt_idx"
    ON "SMSAttempt"("queueId", "createdAt");
CREATE INDEX "SMSCampaign_status_createdAt_idx"
    ON "SMSCampaign"("status", "createdAt");
CREATE INDEX "SMSAdminAudit_actorId_createdAt_idx"
    ON "SMSAdminAudit"("actorId", "createdAt");
CREATE INDEX "SMSAdminAudit_action_createdAt_idx"
    ON "SMSAdminAudit"("action", "createdAt");

ALTER TABLE "SMSAttempt"
    ADD CONSTRAINT "SMSAttempt_queueId_fkey"
    FOREIGN KEY ("queueId") REFERENCES "SMSQueue"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SMSQueue"
    ADD CONSTRAINT "SMSQueue_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "SMSCampaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
