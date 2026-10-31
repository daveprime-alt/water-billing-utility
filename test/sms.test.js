import assert from "node:assert/strict";
import test from "node:test";
import { createAfricaTalkingSmsProvider, SmsProviderError } from "../src/services/africasTalkingSms.js";
import { createSmsWorker, getNairobiDateParts } from "../src/services/smsWorker.js";
import { buildSmsMessage, formatNairobiDate, getCustomerPortalUrl } from "../src/utils/sms.js";
import { createSmsAdminController } from "../src/controllers/smsAdminController.js";

const TEST_PORTAL = "https://billing.example/sign-in";

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

test("SMS templates use the agreed brand, essential payment details, and sign-in link", () => {
    assert.equal(
        buildSmsMessage("new_bill", {
            billingMonth: "2026-10",
            amountCents: 12500,
            dueDate: "2026-11-09",
        }, TEST_PORTAL),
        "CAGNAR FARMS: 2026-10 water bill: KSh 125.00, due 2026-11-09. Pay: https://billing.example/sign-in",
    );
    assert.equal(
        buildSmsMessage("payment_receipt", { amountCents: 12500, receiptCode: "ABC123" }),
        "CAGNAR FARMS: Payment of KSh 125.00 received. M-Pesa receipt: ABC123. Thank you.",
    );
    assert.equal(
        formatNairobiDate(new Date("2026-10-26T22:00:00.000Z")),
        "2026-10-27",
    );
});

test("portal URL requires HTTPS except on localhost outside production", () => {
    assert.throws(
        () => getCustomerPortalUrl({ CUSTOMER_PORTAL_URL: "http://billing.example", NODE_ENV: "production" }),
        /HTTPS/,
    );
    assert.equal(
        getCustomerPortalUrl({ CUSTOMER_PORTAL_URL: "http://localhost:5173/sign-in", NODE_ENV: "development" }),
        "http://localhost:5173/sign-in",
    );
    assert.equal(getCustomerPortalUrl({}), null);
});

test("Africa's Talking adapter uses sandbox credentials and accepts queued messages", async () => {
    let request;
    const provider = createAfricaTalkingSmsProvider({
        AFRICASTALKING_ENV: "sandbox",
        AFRICASTALKING_SANDBOX_URL: "https://api.sandbox.africastalking.com/version1/messaging",
        AFRICASTALKING_USERNAME: "sandbox",
        AFRICASTALKING_API_KEY: "test-key",
        AFRICASTALKING_SENDER_ID: "Test",
    }, {
        async post(url, body, options) {
            request = { url, body, options };
            return {
                data: {
                    SMSMessageData: {
                        Recipients: [{ statusCode: 102, messageId: "AT-id" }],
                    },
                },
            };
        },
    });

    const result = await provider.send({ recipient: "254712345678", message: "Test message" });

    assert.equal(request.url, "https://api.sandbox.africastalking.com/version1/messaging");
    assert.equal(request.body.get("username"), "sandbox");
    assert.equal(request.body.get("to"), "254712345678");
    assert.equal(request.body.get("from"), "Test");
    assert.equal(request.options.headers.apiKey, "test-key");
    assert.deepEqual(result, { providerMessageId: "AT-id" });
});

test("Africa's Talking endpoint configuration is required and restricted to the environment endpoint", () => {
    assert.throws(() => createAfricaTalkingSmsProvider({
        AFRICASTALKING_ENV: "sandbox",
        AFRICASTALKING_USERNAME: "sandbox",
        AFRICASTALKING_API_KEY: "test-key",
    }), /AFRICASTALKING_SANDBOX_URL is required/);

    assert.throws(() => createAfricaTalkingSmsProvider({
        AFRICASTALKING_ENV: "sandbox",
        AFRICASTALKING_SANDBOX_URL: "https://example.com/version1/messaging",
        AFRICASTALKING_USERNAME: "sandbox",
        AFRICASTALKING_API_KEY: "test-key",
    }), /must use https:\/\/api\.sandbox\.africastalking\.com/);
});

test("Africa's Talking production mode cannot start without explicit live enablement", () => {
    assert.throws(() => createAfricaTalkingSmsProvider({
        AFRICASTALKING_ENV: "production",
        AFRICASTALKING_PRODUCTION_URL: "https://api.africastalking.com/version1/messaging",
        AFRICASTALKING_USERNAME: "production",
        AFRICASTALKING_API_KEY: "test-key",
    }), /SMS_LIVE_ENABLED=true/);
    assert.throws(() => createAfricaTalkingSmsProvider({
        AFRICASTALKING_ENV: "production",
        AFRICASTALKING_PRODUCTION_URL: "https://api.africastalking.com/version1/messaging",
        AFRICASTALKING_USERNAME: "production",
        AFRICASTALKING_API_KEY: "test-key",
        SMS_LIVE_ENABLED: "true",
    }), /SENDER_ID/);
});

test("Africa's Talking production mode sends to the configured production endpoint", async () => {
    let requestUrl;
    const provider = createAfricaTalkingSmsProvider({
        AFRICASTALKING_ENV: "production",
        AFRICASTALKING_PRODUCTION_URL: "https://api.africastalking.com/version1/messaging",
        AFRICASTALKING_USERNAME: "production",
        AFRICASTALKING_API_KEY: "test-key",
        AFRICASTALKING_SENDER_ID: "Cagnar",
        SMS_LIVE_ENABLED: "true",
    }, {
        async post(url) {
            requestUrl = url;
            return {
                data: {
                    SMSMessageData: {
                        Recipients: [{ statusCode: 101, messageId: "AT-prod-id" }],
                    },
                },
            };
        },
    });

    await provider.send({ recipient: "254712345678", message: "Test message" });
    assert.equal(requestUrl, "https://api.africastalking.com/version1/messaging");
});

function workerPrisma(claimedMessage, { invoice = null, user = null } = {}) {
    const calls = { updates: [], attempts: [], raw: 0 };
    return {
        calls,
        invoice: {
            async findUnique() {
                return invoice;
            },
        },
        user: {
            async findUnique() {
                return user;
            },
        },
        sMSCampaign: {
            async findMany() {
                return [];
            },
        },
        sMSQueue: {
            async update({ data }) {
                calls.updates.push(data);
            },
        },
        async $transaction(work) {
            return work({
                async $queryRaw(strings) {
                    calls.raw += 1;
                    calls.queryText = strings.join("");
                    if (
                        claimedMessage?.notificationType === "legacy"
                        && calls.queryText.includes('"notificationType" <>')
                    ) {
                        return [];
                    }
                    return claimedMessage ? [claimedMessage] : [];
                },
                sMSQueue: {
                    async update({ data }) {
                        calls.updates.push(data);
                    },
                },
                sMSAttempt: {
                    async create({ data }) {
                        calls.attempts.push(data);
                    },
                },
            });
        },
    };
}

const receiptQueueItem = {
    id: "sms-1",
    recipient: "254712345678",
    message: "Receipt",
    notificationType: "payment_receipt",
    templateData: { amountCents: 12500, receiptCode: "ABC123" },
    attempts: 1,
    deliveryCycle: 0,
    campaignId: null,
};

test("worker records provider acceptance as sent and records each attempt", async () => {
    const prisma = workerPrisma(receiptQueueItem);
    const worker = createSmsWorker({
        prisma,
        provider: { async send() { return { providerMessageId: "provider-1" }; } },
        configuration: { NODE_ENV: "test" },
    });

    assert.equal(await worker.sendOne(), true);
    assert.equal(prisma.calls.updates[0].status, "SENT");
    assert.match(prisma.calls.updates[0].message, /CAGNAR FARMS/);
    assert.equal(prisma.calls.updates[0].providerMessageId, "provider-1");
    assert.match(prisma.calls.queryText, /notificationType.*legacy/);
    assert.deepEqual(prisma.calls.attempts[0], {
        queueId: "sms-1",
        attemptNumber: 1,
        deliveryCycle: 0,
        accepted: true,
        providerMessageId: "provider-1",
    });
});

test("worker leaves legacy queued messages untouched for review", async () => {
    const legacyMessage = { ...receiptQueueItem, notificationType: "legacy" };
    const prisma = workerPrisma(legacyMessage);
    let sends = 0;
    const worker = createSmsWorker({
        prisma,
        provider: { async send() { sends += 1; return {}; } },
        configuration: { NODE_ENV: "test" },
    });

    assert.equal(await worker.sendOne(), false);
    assert.equal(sends, 0);
    assert.equal(prisma.calls.updates.length, 0);
});

test("worker schedules the configured first retry after a temporary error", async () => {
    const prisma = workerPrisma(receiptQueueItem);
    const now = new Date("2026-10-26T10:00:00.000Z");
    const worker = createSmsWorker({
        prisma,
        provider: {
            async send() {
                throw new SmsProviderError("Temporary network error.", { retryable: true });
            },
        },
        configuration: { NODE_ENV: "test" },
        now: () => now,
    });

    await worker.sendOne();

    assert.equal(prisma.calls.updates[0].status, "PENDING");
    assert.equal(prisma.calls.updates[0].nextAttemptAt.toISOString(), "2026-10-26T10:01:00.000Z");
    assert.equal(prisma.calls.attempts[0].accepted, false);
});

test("worker marks the fourth temporary failure terminal after three retries", async () => {
    const prisma = workerPrisma({ ...receiptQueueItem, attempts: 4 });
    const worker = createSmsWorker({
        prisma,
        provider: {
            async send() {
                throw new SmsProviderError("Temporary network error.", { retryable: true });
            },
        },
        configuration: { NODE_ENV: "test" },
        now: () => new Date("2026-10-26T10:00:00.000Z"),
    });

    await worker.sendOne();

    assert.equal(prisma.calls.updates[0].status, "FAILED");
    assert.ok(prisma.calls.updates[0].failedAt instanceof Date);
});

test("expired worker leases are recorded as failed attempts", async () => {
    let attemptRows;
    const prisma = {
        async $transaction(work) {
            return work({
                async $queryRaw() {
                    return [{
                        id: "sms-expired",
                        attempts: 2,
                        deliveryCycle: 1,
                    }];
                },
                sMSAttempt: {
                    async createMany({ data }) {
                        attemptRows = data;
                    },
                },
            });
        },
    };
    const worker = createSmsWorker({
        prisma,
        provider: null,
        configuration: { NODE_ENV: "test" },
        now: () => new Date("2026-10-26T10:00:00.000Z"),
    });

    await worker.recoverExpiredClaims();

    assert.equal(attemptRows.length, 1);
    assert.equal(attemptRows[0].queueId, "sms-expired");
    assert.equal(attemptRows[0].attemptNumber, 2);
    assert.equal(attemptRows[0].deliveryCycle, 1);
    assert.equal(attemptRows[0].accepted, false);
    assert.match(attemptRows[0].errorMessage, /lease expired/);
});

test("worker cancels an overdue reminder when its invoice has since been paid", async () => {
    const prisma = workerPrisma({
        ...receiptQueueItem,
        notificationType: "overdue_reminder",
        templateData: { invoiceId: "invoice-1", billingMonth: "2026-10", amountCents: 12500, dueDate: "2026-10-20" },
    }, { invoice: { status: "PAID" } });
    let sends = 0;
    const worker = createSmsWorker({
        prisma,
        provider: { async send() { sends += 1; return {}; } },
        configuration: { NODE_ENV: "test", CUSTOMER_PORTAL_URL: TEST_PORTAL },
    });

    await worker.sendOne();

    assert.equal(sends, 0);
    assert.equal(prisma.calls.updates[0].status, "CANCELLED");
});

test("reminder scheduler queues a single Kenya-time 9 AM reminder three calendar days after due date", async () => {
    const scheduled = [];
    const prisma = {
        async $queryRaw() {
            return [{
                id: "invoice-1",
                billingMonth: "2026-10",
                closingReceivableCents: 12500,
                dueDate: new Date("2026-10-23T12:00:00.000Z"),
                phoneNumber: "254712345678",
            }];
        },
        sMSQueue: {
            async create({ data }) {
                scheduled.push(data);
            },
        },
    };
    const worker = createSmsWorker({
        prisma,
        provider: null,
        configuration: { NODE_ENV: "test", CUSTOMER_PORTAL_URL: TEST_PORTAL },
        now: () => new Date("2026-10-26T06:00:00.000Z"),
    });

    assert.equal(await worker.enqueueOverdueReminders(), 1);
    assert.equal(scheduled[0].scheduledAt.toISOString(), "2026-10-26T06:00:00.000Z");
    assert.equal(scheduled[0].deduplicationKey, "overdue-reminder:invoice-1");
    assert.equal(scheduled[0].templateData.invoiceId, "invoice-1");
    assert.deepEqual(getNairobiDateParts(scheduled[0].scheduledAt), {
        year: "2026",
        month: "10",
        day: "26",
    });
});

test("admin retry preserves attempt records and starts a new delivery cycle", async () => {
    let updatedMessage;
    let auditRecord;
    const controller = createSmsAdminController({
        async $transaction(work) {
            return work({
                sMSQueue: {
                    async findUnique() {
                        return {
                            id: "sms-failed",
                            status: "FAILED",
                            manualRetryCount: 0,
                            campaignId: null,
                            message: "Bill notice",
                            recipient: "254712345678",
                        };
                    },
                    async updateMany({ data }) {
                        updatedMessage = data;
                        return { count: 1 };
                    },
                },
                sMSCampaign: { async updateMany() {} },
                sMSAdminAudit: {
                    async create({ data }) {
                        auditRecord = data;
                    },
                },
            });
        },
    });
    const res = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };

    await controller.retryMessage({
        params: { id: "sms-failed" },
        user: { id: "admin-1" },
    }, res);

    assert.equal(res.statusCode, 202);
    assert.equal(updatedMessage.status, "PENDING");
    assert.equal(updatedMessage.attempts, 0);
    assert.deepEqual(updatedMessage.deliveryCycle, { increment: 1 });
    assert.deepEqual(updatedMessage.manualRetryCount, { increment: 1 });
    assert.equal(auditRecord.action, "sms.message.retry");
});

test("campaign confirmation rejects a changed phone number despite the same user and count", async () => {
    const originalPortalUrl = process.env.CUSTOMER_PORTAL_URL;
    process.env.CUSTOMER_PORTAL_URL = TEST_PORTAL;
    const campaign = {
        id: "campaign-1",
        message: "Water service interruption.",
        status: "DRAFT",
        previewedAt: new Date(),
        previewedRecipientCount: 1,
        previewedRecipients: [{ id: "preview-user", phoneNumber: "254712345678" }],
    };
    const controller = createSmsAdminController({
        async $transaction(work) {
            return work({
                async $queryRaw() { return [{ id: campaign.id }]; },
                sMSCampaign: {
                    async findUnique() { return structuredClone(campaign); },
                    async update({ data }) { Object.assign(campaign, data); },
                },
                user: {
                    async findMany() {
                        return [{ id: "preview-user", phoneNumber: "254711111111" }];
                    },
                },
            });
        },
    });
    const res = response();

    try {
        await controller.confirmCampaign({
            params: { id: campaign.id },
            user: { id: "admin-1" },
        }, res);
    } finally {
        if (originalPortalUrl === undefined) delete process.env.CUSTOMER_PORTAL_URL;
        else process.env.CUSTOMER_PORTAL_URL = originalPortalUrl;
    }

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /recipients changed/i);
    assert.equal(campaign.previewedRecipients, null);
});

test("concurrent campaign confirmations queue a campaign only once", async () => {
    const originalPortalUrl = process.env.CUSTOMER_PORTAL_URL;
    process.env.CUSTOMER_PORTAL_URL = TEST_PORTAL;
    const campaign = {
        id: "campaign-1",
        message: "Water service interruption.",
        status: "DRAFT",
        previewedAt: new Date(),
        previewedRecipientCount: 1,
        previewedRecipients: [{ id: "user-1", phoneNumber: "254712345678" }],
    };
    const queuedRows = [];
    const tx = {
        async $queryRaw() { return [{ id: campaign.id }]; },
        sMSCampaign: {
            async findUnique() { return structuredClone(campaign); },
            async update({ data }) { Object.assign(campaign, data); },
        },
        user: {
            async findMany() {
                return [{ id: "user-1", phoneNumber: "254712345678" }];
            },
        },
        sMSQueue: {
            async createMany({ data }) {
                queuedRows.push(...data);
                return { count: data.length };
            },
            async count() {
                return queuedRows.length;
            },
        },
        sMSAdminAudit: { async create() {} },
    };
    let transactionQueue = Promise.resolve();
    const prisma = {
        async $transaction(work) {
            const previous = transactionQueue;
            let release;
            transactionQueue = new Promise((resolve) => { release = resolve; });
            await previous;
            try {
                return await work(tx);
            } finally {
                release();
            }
        },
    };
    const controller = createSmsAdminController(prisma);
    const requests = [response(), response()];

    try {
        await Promise.all(requests.map((res) => controller.confirmCampaign({
            params: { id: campaign.id },
            user: { id: "admin-1" },
        }, res)));
    } finally {
        if (originalPortalUrl === undefined) delete process.env.CUSTOMER_PORTAL_URL;
        else process.env.CUSTOMER_PORTAL_URL = originalPortalUrl;
    }

    assert.deepEqual(requests.map((res) => res.statusCode).sort(), [202, 409]);
    assert.equal(queuedRows.length, 1);
    assert.equal(campaign.status, "SENDING");
});
