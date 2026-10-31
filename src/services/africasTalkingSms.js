import axios from "axios";

const MESSAGING_PATH = "/version1/messaging";
const ENDPOINTS = {
    sandbox: {
        variable: "AFRICASTALKING_SANDBOX_URL",
        hostname: "api.sandbox.africastalking.com",
    },
    production: {
        variable: "AFRICASTALKING_PRODUCTION_URL",
        hostname: "api.africastalking.com",
    },
};

function getMessagingEndpoint(mode, configuration) {
    const { variable, hostname } = ENDPOINTS[mode];
    const value = configuration[variable]?.trim();
    if (!value) {
        throw new Error(`${variable} is required.`);
    }

    let endpoint;
    try {
        endpoint = new URL(value);
    } catch {
        throw new Error(`${variable} must be a valid HTTPS Africa's Talking messaging URL.`);
    }
    if (
        endpoint.protocol !== "https:"
        || endpoint.hostname !== hostname
        || endpoint.pathname !== MESSAGING_PATH
        || endpoint.username
        || endpoint.password
        || endpoint.search
        || endpoint.hash
    ) {
        throw new Error(`${variable} must use https://${hostname}${MESSAGING_PATH}.`);
    }
    return endpoint.toString();
}

export class SmsProviderError extends Error {
    constructor(message, { retryable = true, providerMessageId = null } = {}) {
        super(message);
        this.name = "SmsProviderError";
        this.retryable = retryable;
        this.providerMessageId = providerMessageId;
    }
}

export function createAfricaTalkingSmsProvider(configuration = process.env, httpClient = axios) {
    const mode = configuration.AFRICASTALKING_ENV || "sandbox";
    const username = configuration.AFRICASTALKING_USERNAME?.trim();
    const apiKey = configuration.AFRICASTALKING_API_KEY?.trim();
    const senderId = configuration.AFRICASTALKING_SENDER_ID?.trim();

    if (!["sandbox", "production"].includes(mode)) {
        throw new Error("AFRICASTALKING_ENV must be sandbox or production.");
    }
    if (!username || !apiKey) {
        throw new Error("AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY are required.");
    }
    if (mode === "production" && configuration.SMS_LIVE_ENABLED !== "true") {
        throw new Error("Live SMS is disabled. Set SMS_LIVE_ENABLED=true only after production approval.");
    }
    if (mode === "production" && !senderId) {
        throw new Error("AFRICASTALKING_SENDER_ID is required for production SMS.");
    }
    const endpoint = getMessagingEndpoint(mode, configuration);

    return {
        async send({ recipient, message }) {
            const body = new URLSearchParams({
                username,
                to: recipient,
                message,
            });
            if (senderId) body.set("from", senderId);

            let response;
            try {
                response = await httpClient.post(
                    endpoint,
                    body,
                    {
                        headers: {
                            apiKey,
                            Accept: "application/json",
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                        timeout: 15000,
                    },
                );
            } catch (error) {
                const status = error.response?.status;
                throw new SmsProviderError(
                    status ? `Africa's Talking request failed with HTTP ${status}.` : "Africa's Talking request failed due to a network error.",
                    { retryable: !status || status === 408 || status === 429 || status >= 500 },
                );
            }

            const recipients = response.data?.SMSMessageData?.Recipients;
            const firstRecipient = Array.isArray(recipients) ? recipients[0] : null;
            if (
                !firstRecipient
                || !(["100", "101", "102"].includes(String(firstRecipient.statusCode)) || firstRecipient.status === "Success")
            ) {
                throw new SmsProviderError(
                    "Africa's Talking did not accept the SMS for delivery.",
                    {
                        retryable: ["100", "102", "999"].includes(String(firstRecipient?.statusCode)),
                        providerMessageId: firstRecipient?.messageId ?? null,
                    },
                );
            }

            return { providerMessageId: firstRecipient.messageId ?? null };
        },
    };
}
