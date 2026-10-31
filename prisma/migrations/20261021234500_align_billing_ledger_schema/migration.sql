-- Preserve existing status values while aligning their database types with Prisma enums.
CREATE TYPE "SmsStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

ALTER TABLE "Invoice"
    ADD COLUMN "paymentCreditsCents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "unitRateCents" INTEGER;

ALTER TABLE "Invoice"
    ALTER COLUMN "status" DROP DEFAULT,
    ALTER COLUMN "status" TYPE "InvoicesStatus"
        USING "status"::"InvoicesStatus",
    ALTER COLUMN "status" SET DEFAULT 'UNPAID'::"InvoicesStatus";

ALTER TABLE "SMSQueue"
    ALTER COLUMN "status" DROP DEFAULT,
    ALTER COLUMN "status" TYPE "SmsStatus"
        USING "status"::"SmsStatus",
    ALTER COLUMN "status" SET DEFAULT 'PENDING'::"SmsStatus";

ALTER TABLE "User"
    ADD COLUMN "accountNumber" TEXT,
    ALTER COLUMN "passwordHash" DROP NOT NULL,
    ALTER COLUMN "passwordHash" DROP DEFAULT,
    ALTER COLUMN "role" DROP DEFAULT,
    ALTER COLUMN "role" TYPE "Role"
        USING "role"::"Role",
    ALTER COLUMN "role" SET DEFAULT 'CONSUMER'::"Role";

CREATE INDEX "SMSQueue_status_createdAt_idx"
    ON "SMSQueue"("status", "createdAt");

CREATE UNIQUE INDEX "User_accountNumber_key"
    ON "User"("accountNumber");
