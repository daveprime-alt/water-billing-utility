import { PrismaClient } from "@prisma/client";
import { buildSmsMessage, getCustomerPortalUrl } from "../utils/sms.js";

const prisma = new PrismaClient();
const PAGE_SIZE_MAX = 100;
const CAMPAIGN_RECIPIENT_MAX = 1000;
const PREVIEW_MAX_AGE_MS = 10 * 60_000;

function parsePagination(query) {
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 25);
    if (
        !Number.isInteger(page)
        || page < 1
        || !Number.isInteger(pageSize)
        || pageSize < 1
        || pageSize > PAGE_SIZE_MAX
    ) {
        return null;
    }
    return { page, pageSize, skip: (page - 1) * pageSize };
}

function maskPhoneNumber(value) {
    return typeof value === "string" && value.length > 4
        ? `${"*".repeat(Math.min(value.length - 4, 8))}${value.slice(-4)}`
        : "****";
}

function eligibleAnnouncementWhere() {
    return {
        role: "CONSUMER",
        phoneNumber: { not: null },
        smsAnnouncementsOptOutAt: null,
    };
}

async function writeAudit(tx, actorId, action, targetId, details = undefined) {
    await tx.sMSAdminAudit.create({
        data: { actorId, action, targetId, details },
    });
}

export function createSmsAdminController(prismaClient = prisma) {
    return {
        async listMessages(req, res) {
            const pagination = parsePagination(req.query);
            if (!pagination) {
                return res.status(400).json({ error: "Invalid page or pageSize." });
            }
            const statuses = ["PENDING", "PROCESSING", "SENT", "FAILED", "CANCELLED"];
            const status = req.query.status;
            if (status && !statuses.includes(status)) {
                return res.status(400).json({ error: "Unsupported SMS status." });
            }

            try {
                const where = status ? { status } : {};
                const [messages, total] = await Promise.all([
                    prismaClient.sMSQueue.findMany({
                        where,
                        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                        skip: pagination.skip,
                        take: pagination.pageSize,
                        select: {
                            id: true,
                            recipient: true,
                            message: true,
                            status: true,
                            notificationType: true,
                            attempts: true,
                            manualRetryCount: true,
                            errorMessage: true,
                            providerMessageId: true,
                            scheduledAt: true,
                            nextAttemptAt: true,
                            sentAt: true,
                            failedAt: true,
                            createdAt: true,
                            sendAttempts: {
                                orderBy: [{ createdAt: "desc" }],
                                take: 10,
                                select: {
                                    attemptNumber: true,
                                    deliveryCycle: true,
                                    accepted: true,
                                    providerMessageId: true,
                                    errorMessage: true,
                                    createdAt: true,
                                },
                            },
                        },
                    }),
                    prismaClient.sMSQueue.count({ where }),
                ]);
                return res.status(200).json({
                    messages: messages.map(({ recipient, ...message }) => ({
                        ...message,
                        recipient: maskPhoneNumber(recipient),
                    })),
                    pagination: {
                        page: pagination.page,
                        pageSize: pagination.pageSize,
                        total,
                        totalPages: Math.ceil(total / pagination.pageSize),
                    },
                });
            } catch (error) {
                console.error("Failed to list SMS queue messages:", error);
                return res.status(500).json({ error: "Unable to load SMS messages." });
            }
        },

        async retryMessage(req, res) {
            try {
                const result = await prismaClient.$transaction(async (tx) => {
                    const message = await tx.sMSQueue.findUnique({
                        where: { id: req.params.id },
                        select: {
                            id: true,
                            status: true,
                            manualRetryCount: true,
                            campaignId: true,
                            message: true,
                            recipient: true,
                        },
                    });
                    if (!message) return { notFound: true };
                    if (message.status !== "FAILED") return { conflict: true };
                    if (message.message === "[REDACTED]" || message.recipient === "[REDACTED]") {
                        return { expired: true };
                    }

                    const updated = await tx.sMSQueue.updateMany({
                        where: { id: message.id, status: "FAILED" },
                        data: {
                            status: "PENDING",
                            attempts: 0,
                            deliveryCycle: { increment: 1 },
                            manualRetryCount: { increment: 1 },
                            errorMessage: null,
                            failedAt: null,
                            nextAttemptAt: new Date(),
                        },
                    });
                    if (updated.count !== 1) return { conflict: true };
                    await writeAudit(tx, req.user.id, "sms.message.retry", message.id, {
                        previousManualRetryCount: message.manualRetryCount,
                    });
                    if (message.campaignId) {
                        await tx.sMSCampaign.updateMany({
                            where: { id: message.campaignId, status: "COMPLETED" },
                            data: { status: "SENDING", completedAt: null },
                        });
                    }
                    return { queued: true };
                });

                if (result.notFound) {
                    return res.status(404).json({ error: "SMS message was not found." });
                }
                if (result.conflict) {
                    return res.status(409).json({ error: "Only failed SMS messages can be manually retried." });
                }
                if (result.expired) {
                    return res.status(409).json({ error: "SMS details expired and were redacted; this message cannot be retried." });
                }
                return res.status(202).json({ message: "SMS message queued for a manual retry." });
            } catch (error) {
                console.error("Failed to retry SMS message:", error);
                return res.status(500).json({ error: "Unable to retry the SMS message." });
            }
        },

        async listAnnouncementRecipients(req, res) {
            const pagination = parsePagination({ page: req.query.page, pageSize: req.query.pageSize ?? 100 });
            if (!pagination) {
                return res.status(400).json({ error: "Invalid page or pageSize." });
            }
            try {
                const where = eligibleAnnouncementWhere();
                const [recipients, total] = await Promise.all([
                    prismaClient.user.findMany({
                        where,
                        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
                        skip: pagination.skip,
                        take: pagination.pageSize,
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            phoneNumber: true,
                        },
                    }),
                    prismaClient.user.count({ where }),
                ]);
                return res.status(200).json({
                    eligibleCount: total,
                    recipients: recipients.map(({ phoneNumber, ...recipient }) => ({
                        ...recipient,
                        phoneNumber: maskPhoneNumber(phoneNumber),
                    })),
                    pagination: {
                        page: pagination.page,
                        pageSize: pagination.pageSize,
                        total,
                        totalPages: Math.ceil(total / pagination.pageSize),
                    },
                });
            } catch (error) {
                console.error("Failed to preview SMS announcement recipients:", error);
                return res.status(500).json({ error: "Unable to load announcement recipients." });
            }
        },

        async setAnnouncementOptOut(req, res) {
            if (typeof req.body?.optedOut !== "boolean") {
                return res.status(400).json({ error: "optedOut must be a boolean." });
            }
            try {
                const result = await prismaClient.$transaction(async (tx) => {
                    const user = await tx.user.findUnique({
                        where: { id: req.params.userId },
                        select: { id: true, role: true, smsAnnouncementsOptOutAt: true },
                    });
                    if (!user || user.role !== "CONSUMER") return null;

                    const optOutAt = req.body.optedOut ? new Date() : null;
                    await tx.user.update({
                        where: { id: user.id },
                        data: { smsAnnouncementsOptOutAt: optOutAt },
                    });
                    await writeAudit(tx, req.user.id, "sms.announcement.optout.update", user.id, {
                        optedOut: req.body.optedOut,
                    });
                    return { optedOut: req.body.optedOut, optedOutAt: optOutAt };
                });
                if (!result) {
                    return res.status(404).json({ error: "Consumer account was not found." });
                }
                return res.status(200).json(result);
            } catch (error) {
                console.error("Failed to update SMS announcement preference:", error);
                return res.status(500).json({ error: "Unable to update the announcement preference." });
            }
        },

        async listAnnouncementPreferences(req, res) {
            const pagination = parsePagination(req.query);
            if (!pagination) return res.status(400).json({ error: "Invalid page or pageSize." });
            const optedOut = req.query.optedOut;
            if (optedOut !== undefined && !["true", "false"].includes(optedOut)) {
                return res.status(400).json({ error: "optedOut must be true or false." });
            }
            const where = {
                role: "CONSUMER",
                phoneNumber: { not: null },
                ...(optedOut === undefined
                    ? {}
                    : { smsAnnouncementsOptOutAt: optedOut === "true" ? { not: null } : null }),
            };
            try {
                const [users, total] = await Promise.all([
                    prismaClient.user.findMany({
                        where,
                        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
                        skip: pagination.skip,
                        take: pagination.pageSize,
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            phoneNumber: true,
                            smsAnnouncementsOptOutAt: true,
                        },
                    }),
                    prismaClient.user.count({ where }),
                ]);
                return res.status(200).json({
                    preferences: users.map(({ phoneNumber, ...user }) => ({
                        ...user,
                        phoneNumber: maskPhoneNumber(phoneNumber),
                        optedOut: Boolean(user.smsAnnouncementsOptOutAt),
                    })),
                    pagination: {
                        page: pagination.page,
                        pageSize: pagination.pageSize,
                        total,
                        totalPages: Math.ceil(total / pagination.pageSize),
                    },
                });
            } catch (error) {
                console.error("Failed to list SMS announcement preferences:", error);
                return res.status(500).json({ error: "Unable to load announcement preferences." });
            }
        },

        async createCampaign(req, res) {
            const message = req.body?.message;
            if (typeof message !== "string" || message.trim().length < 5 || message.trim().length > 500) {
                return res.status(400).json({ error: "Operational notice must be between 5 and 500 characters." });
            }
            try {
                const campaign = await prismaClient.sMSCampaign.create({
                    data: { message: message.trim(), createdById: req.user.id },
                    select: { id: true, message: true, status: true, createdAt: true },
                });
                return res.status(201).json({ campaign });
            } catch (error) {
                console.error("Failed to create SMS announcement draft:", error);
                return res.status(500).json({ error: "Unable to create an announcement draft." });
            }
        },

        async previewCampaign(req, res) {
            try {
                const result = await prismaClient.$transaction(async (tx) => {
                    const campaign = await tx.sMSCampaign.findUnique({
                        where: { id: req.params.id },
                    });
                    if (!campaign) return { notFound: true };
                    if (campaign.status !== "DRAFT") return { conflict: true };

                    const where = eligibleAnnouncementWhere();
                    const [eligibleCount, recipients] = await Promise.all([
                        tx.user.count({ where }),
                        tx.user.findMany({
                            where,
                            orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
                            take: 1000,
                            select: { id: true, firstName: true, lastName: true, phoneNumber: true },
                        }),
                    ]);
                    const previewMessage = buildSmsMessage(
                        "admin_announcement",
                        { message: campaign.message },
                        getCustomerPortalUrl(),
                    );
                    if ([...previewMessage].length > 1600) return { tooLong: true };
                    const previewedAt = new Date();
                    await tx.sMSCampaign.update({
                        where: { id: campaign.id },
                        data: {
                            previewedAt,
                            previewedRecipientCount: eligibleCount,
                            previewedRecipients: eligibleCount <= CAMPAIGN_RECIPIENT_MAX
                                ? recipients.map(({ id, phoneNumber }) => ({ id, phoneNumber }))
                                : null,
                        },
                    });
                    return {
                        campaignId: campaign.id,
                        message: previewMessage,
                        eligibleCount,
                        overLimit: eligibleCount > CAMPAIGN_RECIPIENT_MAX,
                        previewedAt,
                        recipients: recipients.map(({ phoneNumber, ...recipient }) => ({
                            ...recipient,
                            phoneNumber: maskPhoneNumber(phoneNumber),
                        })),
                        truncated: eligibleCount > recipients.length,
                    };
                }, { isolationLevel: "RepeatableRead" });
                if (result.notFound) return res.status(404).json({ error: "Announcement draft was not found." });
                if (result.conflict) return res.status(409).json({ error: "Only draft announcements can be previewed." });
                if (result.tooLong) return res.status(400).json({ error: "The announcement exceeds the 1,600-character SMS limit." });
                return res.status(200).json(result);
            } catch (error) {
                console.error("Failed to preview SMS announcement:", error);
                return res.status(500).json({ error: "Unable to preview the announcement." });
            }
        },

        async confirmCampaign(req, res) {
            try {
                if (!getCustomerPortalUrl()) {
                    return res.status(409).json({
                        error: "Configure CUSTOMER_PORTAL_URL before confirming an announcement.",
                    });
                }
            } catch (error) {
                return res.status(500).json({ error: error.message });
            }
            try {
                const result = await prismaClient.$transaction(async (tx) => {
                    await tx.$queryRaw`
                        SELECT "id"
                        FROM "SMSCampaign"
                        WHERE "id" = ${req.params.id}
                        FOR UPDATE
                    `;
                    const campaign = await tx.sMSCampaign.findUnique({
                        where: { id: req.params.id },
                    });
                    if (!campaign) return { notFound: true };
                    if (
                        campaign.status !== "DRAFT"
                        || !campaign.previewedAt
                        || Date.now() - campaign.previewedAt.getTime() > PREVIEW_MAX_AGE_MS
                    ) {
                        return { stale: true };
                    }

                    const recipients = await tx.user.findMany({
                        where: eligibleAnnouncementWhere(),
                        orderBy: [{ id: "asc" }],
                        select: { id: true, phoneNumber: true },
                    });
                    const previewedRecipients = Array.isArray(campaign.previewedRecipients)
                        ? campaign.previewedRecipients
                        : [];
                    const previewedById = new Map(
                        previewedRecipients
                            .filter((recipient) => recipient && typeof recipient.id === "string")
                            .map((recipient) => [recipient.id, recipient.phoneNumber]),
                    );
                    const audienceMatches = recipients.length === previewedRecipients.length
                        && recipients.every((recipient) =>
                            previewedById.get(recipient.id) === recipient.phoneNumber);
                    if (
                        recipients.length !== campaign.previewedRecipientCount
                        || !audienceMatches
                    ) {
                        await tx.sMSCampaign.update({
                            where: { id: campaign.id },
                            data: {
                                previewedAt: null,
                                previewedRecipientCount: null,
                                previewedRecipients: null,
                            },
                        });
                        return { changed: true };
                    }
                    if (recipients.length > CAMPAIGN_RECIPIENT_MAX) return { overLimit: true };

                    const announcementText = buildSmsMessage(
                        "admin_announcement",
                        { message: campaign.message },
                        getCustomerPortalUrl(),
                    );
                    if ([...announcementText].length > 1600) return { tooLong: true };
                    const rows = recipients.map((recipient) => ({
                        recipient: recipient.phoneNumber,
                        message: announcementText,
                        notificationType: "admin_announcement",
                        deduplicationKey: `campaign:${campaign.id}:${recipient.id}`,
                        templateData: { message: campaign.message },
                        campaignId: campaign.id,
                    }));
                    if (rows.length) {
                        await tx.sMSQueue.createMany({ data: rows, skipDuplicates: true });
                    }
                    const activeMessageCount = await tx.sMSQueue.count({
                        where: {
                            campaignId: campaign.id,
                            status: { in: ["PENDING", "PROCESSING"] },
                        },
                    });
                    const nextStatus = activeMessageCount === 0 ? "COMPLETED" : "SENDING";
                    await tx.sMSCampaign.update({
                        where: { id: campaign.id },
                        data: {
                            status: nextStatus,
                            recipientCount: recipients.length,
                            confirmedAt: new Date(),
                            completedAt: nextStatus === "COMPLETED" ? new Date() : null,
                            previewedRecipients: null,
                        },
                    });
                    await writeAudit(tx, req.user.id, "sms.campaign.confirm", campaign.id, {
                        recipientCount: recipients.length,
                    });
                    return { confirmed: true, recipientCount: recipients.length, status: nextStatus };
                });
                if (result.notFound) return res.status(404).json({ error: "Announcement draft was not found." });
                if (result.stale) return res.status(409).json({ error: "Preview the draft again before confirming it." });
                if (result.changed) return res.status(409).json({ error: "Eligible recipients changed. Preview again before confirming." });
                if (result.tooLong) return res.status(400).json({ error: "The announcement exceeds the 1,600-character SMS limit." });
                if (result.overLimit) return res.status(409).json({ error: `Campaigns are limited to ${CAMPAIGN_RECIPIENT_MAX} recipients in the initial release.` });
                return res.status(202).json({
                    message: "Announcement confirmed and queued.",
                    campaign: { recipientCount: result.recipientCount, status: result.status },
                });
            } catch (error) {
                console.error("Failed to confirm SMS announcement:", error);
                return res.status(500).json({ error: "Unable to queue the announcement." });
            }
        },

        async listCampaigns(req, res) {
            const pagination = parsePagination(req.query);
            if (!pagination) return res.status(400).json({ error: "Invalid page or pageSize." });
            try {
                const [campaigns, total] = await Promise.all([
                    prismaClient.sMSCampaign.findMany({
                        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                        skip: pagination.skip,
                        take: pagination.pageSize,
                        select: {
                            id: true,
                            message: true,
                            status: true,
                            recipientCount: true,
                            createdById: true,
                            createdAt: true,
                            confirmedAt: true,
                            pausedAt: true,
                            completedAt: true,
                            _count: { select: { messages: true } },
                        },
                    }),
                    prismaClient.sMSCampaign.count(),
                ]);
                const campaignIds = campaigns.map((campaign) => campaign.id);
                const statusCounts = campaignIds.length
                    ? await prismaClient.sMSQueue.groupBy({
                        by: ["campaignId", "status"],
                        where: { campaignId: { in: campaignIds } },
                        _count: { _all: true },
                    })
                    : [];
                const countsByCampaign = new Map();
                for (const count of statusCounts) {
                    const counts = countsByCampaign.get(count.campaignId) ?? {};
                    counts[count.status.toLowerCase()] = count._count._all;
                    countsByCampaign.set(count.campaignId, counts);
                }
                return res.status(200).json({
                    campaigns: campaigns.map((campaign) => ({
                        ...campaign,
                        progress: countsByCampaign.get(campaign.id) ?? {},
                    })),
                    pagination: {
                        page: pagination.page,
                        pageSize: pagination.pageSize,
                        total,
                        totalPages: Math.ceil(total / pagination.pageSize),
                    },
                });
            } catch (error) {
                console.error("Failed to list SMS announcements:", error);
                return res.status(500).json({ error: "Unable to load announcements." });
            }
        },

        async listAudit(req, res) {
            const pagination = parsePagination(req.query);
            if (!pagination) return res.status(400).json({ error: "Invalid page or pageSize." });
            try {
                const [entries, total] = await Promise.all([
                    prismaClient.sMSAdminAudit.findMany({
                        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                        skip: pagination.skip,
                        take: pagination.pageSize,
                        select: {
                            id: true,
                            actorId: true,
                            action: true,
                            targetId: true,
                            details: true,
                            createdAt: true,
                        },
                    }),
                    prismaClient.sMSAdminAudit.count(),
                ]);
                return res.status(200).json({
                    entries,
                    pagination: {
                        page: pagination.page,
                        pageSize: pagination.pageSize,
                        total,
                        totalPages: Math.ceil(total / pagination.pageSize),
                    },
                });
            } catch (error) {
                console.error("Failed to list SMS administration audit:", error);
                return res.status(500).json({ error: "Unable to load SMS audit history." });
            }
        },

        async updateCampaignState(req, res) {
            const action = req.params.action;
            const transition = action === "pause"
                ? { current: "SENDING", next: "PAUSED", pausedAt: new Date() }
                : action === "resume"
                    ? { current: "PAUSED", next: "SENDING", pausedAt: null }
                    : null;
            if (!transition) return res.status(404).json({ error: "Unsupported campaign action." });

            try {
                const result = await prismaClient.$transaction(async (tx) => {
                    const updated = await tx.sMSCampaign.updateMany({
                        where: { id: req.params.id, status: transition.current },
                        data: { status: transition.next, pausedAt: transition.pausedAt },
                    });
                    if (updated.count === 0) {
                        const campaign = await tx.sMSCampaign.findUnique({
                            where: { id: req.params.id },
                            select: { id: true },
                        });
                        return campaign ? { conflict: true } : { notFound: true };
                    }
                    await writeAudit(tx, req.user.id, `sms.campaign.${action}`, req.params.id);
                    return { updated: true };
                });
                if (result.notFound) return res.status(404).json({ error: "Announcement was not found." });
                if (result.conflict) return res.status(409).json({ error: `Announcement cannot be ${action}d in its current state.` });
                return res.status(200).json({
                    message: action === "pause" ? "Announcement paused." : "Announcement resumed.",
                });
            } catch (error) {
                console.error("Failed to update SMS announcement state:", error);
                return res.status(500).json({ error: "Unable to update the announcement." });
            }
        },
    };
}

export const smsAdminController = createSmsAdminController();
