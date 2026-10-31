const SMS_BRAND = "CAGNAR FARMS";

export function formatNairobiDate(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function formatAmount(amountCents) {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
        throw new Error("SMS amount must be a non-negative integer number of cents.");
    }
    return `KSh ${(amountCents / 100).toFixed(2)}`;
}

export function getCustomerPortalUrl(configuration = process.env) {
    const value = configuration.CUSTOMER_PORTAL_URL?.trim();
    if (!value) return null;

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("CUSTOMER_PORTAL_URL must be a valid absolute URL.");
    }
    if (
        parsed.protocol !== "https:"
        && !(configuration.NODE_ENV !== "production" && parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))
    ) {
        throw new Error("CUSTOMER_PORTAL_URL must use HTTPS outside local development.");
    }
    return parsed.toString().replace(/\/$/, "");
}

export function buildSmsMessage(notificationType, data, portalUrl) {
    switch (notificationType) {
        case "new_bill":
            return `${SMS_BRAND}: ${data.billingMonth} water bill: ${formatAmount(data.amountCents)}, due ${data.dueDate}. Pay: ${portalUrl || "{{CUSTOMER_PORTAL_URL}}"}`;
        case "payment_receipt":
            return `${SMS_BRAND}: Payment of ${formatAmount(data.amountCents)} received. M-Pesa receipt: ${data.receiptCode}. Thank you.`;
        case "overdue_reminder":
            return `${SMS_BRAND}: Your ${data.billingMonth} bill of ${formatAmount(data.amountCents)} was due ${data.dueDate}. Pay: ${portalUrl || "{{CUSTOMER_PORTAL_URL}}"}`;
        case "admin_announcement":
            return `${SMS_BRAND}: ${data.message.trim()} Details: ${portalUrl || "{{CUSTOMER_PORTAL_URL}}"}`;
        default:
            return data.message;
    }
}

export async function enqueueSms(tx, {
    recipient,
    notificationType,
    deduplicationKey,
    templateData,
    scheduledAt = new Date(),
    campaignId = null,
}) {
    if (!recipient || !deduplicationKey) return null;
    const portalUrl = getCustomerPortalUrl();
    const message = buildSmsMessage(notificationType, templateData, portalUrl);

    return tx.sMSQueue.upsert({
        where: { deduplicationKey },
        create: {
            recipient,
            message,
            notificationType,
            deduplicationKey,
            templateData,
            scheduledAt,
            nextAttemptAt: scheduledAt,
            campaignId,
        },
        update: {},
    });
}
