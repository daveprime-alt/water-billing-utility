import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createAfricaTalkingSmsProvider } from "../src/services/africasTalkingSms.js";
import { createSmsWorker } from "../src/services/smsWorker.js";

dotenv.config();

const prisma = new PrismaClient();
const enabled = process.env.SMS_ENABLED === "true";
const pollIntervalMs = Number.parseInt(process.env.SMS_POLL_INTERVAL_MS || "5000", 10);
const sendIntervalMs = Number.parseInt(process.env.SMS_SEND_INTERVAL_MS || "1000", 10);

if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500 || pollIntervalMs > 60_000) {
    throw new Error("SMS_POLL_INTERVAL_MS must be between 500 and 60000.");
}
if (!Number.isInteger(sendIntervalMs) || sendIntervalMs < 1000 || sendIntervalMs > 60_000) {
    throw new Error("SMS_SEND_INTERVAL_MS must be between 1000 and 60000.");
}

const worker = createSmsWorker({
    prisma,
    provider: enabled ? createAfricaTalkingSmsProvider() : null,
});
let stopping = false;
let lastReminderScanAt = 0;
let lastMaintenanceAt = 0;

async function sleep(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
    console.info(`SMS worker started. Sending is ${enabled ? "enabled" : "disabled"}.`);
    if (enabled && !process.env.CUSTOMER_PORTAL_URL) {
        console.warn("Bill, reminder, and announcement SMS will remain queued until CUSTOMER_PORTAL_URL is configured.");
    }
    while (!stopping) {
        try {
            const currentTime = Date.now();
            if (currentTime - lastReminderScanAt >= 60_000) {
                const queued = await worker.enqueueOverdueReminders();
                lastReminderScanAt = currentTime;
                if (queued > 0) console.info("Queued overdue SMS reminders.", { count: queued });
            }
            if (currentTime - lastMaintenanceAt >= 60_000) {
                await worker.recoverExpiredClaims();
                await worker.redactExpiredDetails();
                await worker.refreshCampaignStatuses();
                lastMaintenanceAt = currentTime;
            }
            if (enabled && await worker.sendOne()) {
                await sleep(sendIntervalMs);
                continue;
            }
        } catch (error) {
            console.error("SMS worker iteration failed.", error);
        }
        await sleep(pollIntervalMs);
    }
}

async function shutdown() {
    stopping = true;
    await prisma.$disconnect();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

run().catch(async (error) => {
    console.error("SMS worker stopped unexpectedly.", error);
    await shutdown();
    process.exitCode = 1;
});
