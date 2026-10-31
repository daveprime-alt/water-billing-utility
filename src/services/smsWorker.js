import { buildSmsMessage, getCustomerPortalUrl } from "../utils/sms.js";
import { SmsProviderError } from "./africasTalkingSms.js";
import { randomUUID } from "node:crypto";

const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000];
const STALE_LOCK_MS = 10 * 60_000;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
function safeErrorMessage(error) {
    return String(error?.message || "SMS delivery failed.").slice(0, 300);
}

export function getNairobiDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    return Object.fromEntries(
        parts.filter(({ type }) => ["year", "month", "day"].includes(type))
            .map(({ type, value }) => [type, value]),
    );
}

function addCalendarDays(dateParts, amount) {
    const date = new Date(Date.UTC(
        Number(dateParts.year),
        Number(dateParts.month) - 1,
        Number(dateParts.day) + amount,
    ));
    return {
        year: String(date.getUTCFullYear()).padStart(4, "0"),
        month: String(date.getUTCMonth() + 1).padStart(2, "0"),
        day: String(date.getUTCDate()).padStart(2, "0"),
    };
}

function nairobiNineAm(dateParts) {
    return new Date(Date.UTC(
        Number(dateParts.year),
        Number(dateParts.month) - 1,
        Number(dateParts.day),
        6,
    ));
}

function nairobiStartOfDayUtc(dateParts) {
    return new Date(Date.UTC(
        Number(dateParts.year),
        Number(dateParts.month) - 1,
        Number(dateParts.day),
        -3,
    ));
}

export function createSmsWorker({
    prisma,
    provider,
    configuration = process.env,
    now = () => new Date(),
}) {
    const portalUrl = getCustomerPortalUrl(configuration);

    async function enqueueOverdueReminders() {
        const today = getNairobiDateParts(now());
        const latestDueDateExclusive = nairobiStartOfDayUtc(addCalendarDays(today, -2));
        const invoices = await prisma.$queryRaw`
            SELECT i."id", i."billingMonth", i."closingReceivableCents", i."dueDate",
                u."phoneNumber"
            FROM "Invoice" i
            JOIN "MeterReading" r ON r."id" = i."readingId"
            JOIN "User" u ON u."id" = r."customerId"
            WHERE i."status" = 'UNPAID'::"InvoicesStatus"
              AND i."dueDate" < ${latestDueDateExclusive}
              AND u."phoneNumber" IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM "SMSQueue" q
                  WHERE q."deduplicationKey" = 'overdue-reminder:' || i."id"
              )
            ORDER BY i."dueDate" ASC, i."id" ASC
        `;

        let queued = 0;
        for (const invoice of invoices) {
            const recipient = invoice.phoneNumber;
            if (!recipient) continue;
            const dueDateParts = getNairobiDateParts(invoice.dueDate);
            const reminderDate = addCalendarDays(dueDateParts, 3);
            const scheduledAt = nairobiNineAm(reminderDate);
            const templateData = {
                invoiceId: invoice.id,
                billingMonth: invoice.billingMonth,
                amountCents: invoice.closingReceivableCents,
                dueDate: `${dueDateParts.year}-${dueDateParts.month}-${dueDateParts.day}`,
            };

            try {
                await prisma.sMSQueue.create({
                    data: {
                        recipient,
                        message: buildSmsMessage("overdue_reminder", templateData, portalUrl),
                        notificationType: "overdue_reminder",
                        deduplicationKey: `overdue-reminder:${invoice.id}`,
                        templateData,
                        scheduledAt,
                        nextAttemptAt: scheduledAt,
                    },
                });
                queued += 1;
            } catch (error) {
                if (error?.code !== "P2002") throw error;
            }
        }
        return queued;
    }

    async function recoverExpiredClaims() {
        const cutoff = new Date(now().getTime() - STALE_LOCK_MS);
        await prisma.$transaction(async (tx) => {
            const recovered = await tx.$queryRaw`
                UPDATE "SMSQueue"
                SET
                    "status" = CASE WHEN "attempts" >= 4 THEN 'FAILED'::"SmsStatus" ELSE 'PENDING'::"SmsStatus" END,
                    "lockedAt" = NULL,
                    "nextAttemptAt" = CURRENT_TIMESTAMP,
                    "failedAt" = CASE WHEN "attempts" >= 4 THEN CURRENT_TIMESTAMP ELSE NULL END,
                    "errorMessage" = 'Worker lease expired before completion.'
                WHERE "status" = 'PROCESSING'::"SmsStatus"
                  AND "lockedAt" < ${cutoff}
                RETURNING "id", "attempts", "deliveryCycle"
            `;
            if (recovered.length) {
                await tx.sMSAttempt.createMany({
                    data: recovered.map((message) => ({
                        id: randomUUID(),
                        queueId: message.id,
                        attemptNumber: message.attempts,
                        deliveryCycle: message.deliveryCycle,
                        accepted: false,
                        errorMessage: "Worker lease expired before completion.",
                    })),
                });
            }
        });
    }

    async function claimNextMessage() {
        return prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw`
                WITH candidate AS (
                    SELECT q."id"
                    FROM "SMSQueue" q
                    WHERE q."status" = 'PENDING'::"SmsStatus"
                      AND q."notificationType" <> 'legacy'
                      AND q."scheduledAt" <= ${now()}
                      AND q."nextAttemptAt" <= ${now()}
                      AND (
                          q."campaignId" IS NULL
                          OR EXISTS (
                              SELECT 1 FROM "SMSCampaign" c
                              WHERE c."id" = q."campaignId"
                                AND c."status" = 'SENDING'::"SmsCampaignStatus"
                          )
                      )
                      AND (
                          q."notificationType" NOT IN ('new_bill', 'overdue_reminder', 'admin_announcement')
                          OR ${portalUrl}::text IS NOT NULL
                      )
                    ORDER BY q."scheduledAt" ASC, q."createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE "SMSQueue" q
                SET
                    "status" = 'PROCESSING'::"SmsStatus",
                    "attempts" = q."attempts" + 1,
                    "lockedAt" = ${now()}
                FROM candidate
                WHERE q."id" = candidate."id"
                RETURNING q."id", q."recipient", q."message", q."notificationType",
                    q."templateData", q."attempts", q."campaignId", q."deliveryCycle"
            `;
            return rows[0] ?? null;
        });
    }

    async function recordAccepted(message, providerResult, body) {
        await prisma.$transaction(async (tx) => {
            await tx.sMSQueue.update({
                where: { id: message.id },
                data: {
                    status: "SENT",
                    message: body,
                    providerMessageId: providerResult.providerMessageId,
                    errorMessage: null,
                    lockedAt: null,
                    sentAt: now(),
                },
            });
            await tx.sMSAttempt.create({
                data: {
                    queueId: message.id,
                    attemptNumber: message.attempts,
                    deliveryCycle: message.deliveryCycle ?? 0,
                    accepted: true,
                    providerMessageId: providerResult.providerMessageId,
                },
            });
        });
    }

    async function recordFailure(message, error) {
        const retryable = error instanceof SmsProviderError ? error.retryable : false;
        const shouldRetry = retryable && message.attempts < 4;
        const nextAttemptAt = shouldRetry
            ? new Date(now().getTime() + RETRY_DELAYS_MS[message.attempts - 1])
            : null;
        const errorMessage = safeErrorMessage(error);

        await prisma.$transaction(async (tx) => {
            await tx.sMSQueue.update({
                where: { id: message.id },
                data: {
                    status: shouldRetry ? "PENDING" : "FAILED",
                    errorMessage,
                    lockedAt: null,
                    nextAttemptAt: nextAttemptAt ?? now(),
                    failedAt: shouldRetry ? null : now(),
                },
            });
            await tx.sMSAttempt.create({
                data: {
                    queueId: message.id,
                    attemptNumber: message.attempts,
                    deliveryCycle: message.deliveryCycle ?? 0,
                    accepted: false,
                    errorMessage,
                },
            });
        });
        console.warn("SMS delivery attempt failed.", {
            queueId: message.id,
            attempt: message.attempts,
            retryScheduled: shouldRetry,
        });
    }

    async function refreshCampaignStatuses() {
        const campaigns = await prisma.sMSCampaign.findMany({
            where: { status: "SENDING" },
            select: { id: true },
        });
        for (const campaign of campaigns) {
            const remaining = await prisma.sMSQueue.count({
                where: {
                    campaignId: campaign.id,
                    status: { in: ["PENDING", "PROCESSING"] },
                },
            });
            if (remaining === 0) {
                await prisma.sMSCampaign.updateMany({
                    where: { id: campaign.id, status: "SENDING" },
                    data: { status: "COMPLETED", completedAt: now() },
                });
            }
        }
    }

    async function redactExpiredDetails() {
        const cutoff = new Date(now().getTime() - RETENTION_MS);
        await prisma.sMSQueue.updateMany({
            where: {
                status: { in: ["SENT", "FAILED", "CANCELLED"] },
                OR: [
                    { sentAt: { lt: cutoff }, message: { not: "[REDACTED]" } },
                    { failedAt: { lt: cutoff }, message: { not: "[REDACTED]" } },
                    { cancelledAt: { lt: cutoff }, message: { not: "[REDACTED]" } },
                ],
            },
            data: {
                recipient: "[REDACTED]",
                message: "[REDACTED]",
                templateData: null,
                errorMessage: null,
            },
        });
        await prisma.sMSAttempt.updateMany({
            where: { createdAt: { lt: cutoff }, errorMessage: { not: null } },
            data: { errorMessage: null },
        });
        await prisma.sMSCampaign.updateMany({
            where: { status: "COMPLETED", completedAt: { lt: cutoff }, message: { not: "[REDACTED]" } },
            data: { message: "[REDACTED]" },
        });
    }

    async function sendOne() {
        const message = await claimNextMessage();
        if (!message) return false;

        try {
            const templateData = message.templateData ?? { message: message.message };
            if (message.notificationType === "overdue_reminder") {
                const invoice = await prisma.invoice.findUnique({
                    where: { id: templateData.invoiceId },
                    select: { status: true },
                });
                if (!invoice || invoice.status !== "UNPAID") {
                    await prisma.sMSQueue.update({
                        where: { id: message.id },
                        data: {
                            status: "CANCELLED",
                            attempts: { decrement: 1 },
                            cancelledAt: now(),
                            lockedAt: null,
                            errorMessage: null,
                        },
                    });
                    await refreshCampaignStatuses();
                    return true;
                }
            }
            if (message.notificationType === "admin_announcement") {
                const recipient = await prisma.user.findUnique({
                    where: { phoneNumber: message.recipient },
                    select: { role: true, smsAnnouncementsOptOutAt: true },
                });
                if (
                    !recipient
                    || recipient.role !== "CONSUMER"
                    || recipient.smsAnnouncementsOptOutAt !== null
                ) {
                    await prisma.sMSQueue.update({
                        where: { id: message.id },
                        data: {
                            status: "CANCELLED",
                            attempts: { decrement: 1 },
                            cancelledAt: now(),
                            lockedAt: null,
                            errorMessage: null,
                        },
                    });
                    await refreshCampaignStatuses();
                    return true;
                }
            }
            if (message.campaignId) {
                const campaign = await prisma.sMSCampaign.findUnique({
                    where: { id: message.campaignId },
                    select: { status: true },
                });
                if (!campaign || campaign.status !== "SENDING") {
                    await prisma.sMSQueue.update({
                        where: { id: message.id },
                        data: {
                            status: "PENDING",
                            attempts: { decrement: 1 },
                            lockedAt: null,
                        },
                    });
                    await refreshCampaignStatuses();
                    return true;
                }
            }
            const body = message.templateData
                ? buildSmsMessage(message.notificationType, templateData, portalUrl)
                : message.message;
            if (body.includes("{{CUSTOMER_PORTAL_URL}}")) {
                throw new Error("SMS cannot be sent before CUSTOMER_PORTAL_URL is configured.");
            }
            if ([...body].length > 1600) {
                throw new SmsProviderError("SMS exceeds the 1,600-character safety limit.", { retryable: false });
            }
            const providerResult = await provider.send({
                recipient: message.recipient,
                message: body,
            });
            await recordAccepted(message, providerResult, body);
        } catch (error) {
            await recordFailure(message, error);
        }
        await refreshCampaignStatuses();
        return true;
    }

    return {
        enqueueOverdueReminders,
        recoverExpiredClaims,
        redactExpiredDetails,
        refreshCampaignStatuses,
        sendOne,
    };
}
