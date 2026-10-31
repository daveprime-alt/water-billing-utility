import assert from "node:assert/strict";
import test from "node:test";
import { createInitiateMpesaPaymentHandler } from "../src/services/mpesaPayment.js";

const INVOICE = {
    id: "invoice-12345678",
    status: "UNPAID",
    closingReceivableCents: 12500,
    billingMonth: "2026-10",
    reading: {
        customerId: "consumer-1",
        customer: { phoneNumber: "254712345678" },
    },
};

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

function createPrisma() {
    const state = {
        invoiceStatus: "UNPAID",
        transactions: [],
        reservations: 0,
    };
    return {
        state,
        invoice: {
            async findUnique() {
                return { ...structuredClone(INVOICE), status: state.invoiceStatus };
            },
            async updateMany({ where, data }) {
                if (
                    state.invoiceStatus !== where.status
                    || where.closingReceivableCents !== INVOICE.closingReceivableCents
                ) {
                    return { count: 0 };
                }
                state.invoiceStatus = data.status;
                state.reservations += 1;
                return { count: 1 };
            },
        },
        mPesaTransaction: {
            async create({ data }) {
                state.transactions.push(data);
                return data;
            },
        },
    };
}

const configuration = {
    MPESA_ENV: "sandbox",
    MPESA_BUSINESS_SHORTCODE: "123456",
    MPESA_PASSKEY: "test-passkey",
    MPESA_CALLBACK_URL: "https://api.example.test/callback",
};
const request = {
    params: { id: INVOICE.id },
    user: { id: "consumer-1", role: "CONSUMER" },
    body: { phoneNumber: "0712345678" },
};

test("only one concurrent STK request can reserve an unpaid invoice", async () => {
    const prisma = createPrisma();
    let providerCalls = 0;
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post() {
                providerCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 5));
                return {
                    data: {
                        ResponseCode: "0",
                        MerchantRequestID: "merchant-1",
                        CheckoutRequestID: "checkout-1",
                    },
                };
            },
        },
    });
    const responses = [response(), response()];

    await Promise.all(responses.map((res) => handler(request, res)));

    assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [200, 409]);
    assert.equal(prisma.state.reservations, 1);
    assert.equal(providerCalls, 1);
    assert.equal(prisma.state.transactions.length, 1);
    assert.equal(prisma.state.invoiceStatus, "PENDING_PAYMENT");
});

test("STK Push uses the normalized phone number supplied in the request", async () => {
    const prisma = createPrisma();
    let stkPayload;
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post(_url, payload) {
                stkPayload = payload;
                return {
                    data: {
                        ResponseCode: "0",
                        MerchantRequestID: "merchant-1",
                        CheckoutRequestID: "checkout-1",
                    },
                };
            },
        },
    });
    const res = response();

    await handler({
        ...request,
        body: { phoneNumber: "+254 711 222 333" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(stkPayload.PartyA, "254711222333");
    assert.equal(stkPayload.PhoneNumber, "254711222333");
    assert.equal(prisma.state.transactions[0].customerPhone, "254711222333");
    assert.equal(prisma.state.invoiceStatus, "PENDING_PAYMENT");
    assert.equal(res.body.checkoutRequestId, "checkout-1");
    assert.match(res.body.message, /payment status updates after confirmation/i);
});

test("STK Push rejects an invalid supplied phone number before reserving the invoice", async () => {
    const prisma = createPrisma();
    let providerCalled = false;
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post() {
                providerCalled = true;
            },
        },
    });
    const res = response();

    await handler({ ...request, body: { phoneNumber: "12345" } }, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /valid Kenyan mobile/i);
    assert.equal(providerCalled, false);
    assert.equal(prisma.state.reservations, 0);
    assert.equal(prisma.state.invoiceStatus, "UNPAID");
});

test("STK Push preserves invoice ownership authorization", async () => {
    const prisma = createPrisma();
    let providerCalled = false;
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post() {
                providerCalled = true;
            },
        },
    });
    const res = response();

    await handler({
        ...request,
        user: { id: "another-consumer", role: "CONSUMER" },
    }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(providerCalled, false);
    assert.equal(prisma.state.reservations, 0);
});

test("STK Push preserves invoice status checks", async () => {
    const prisma = createPrisma();
    prisma.state.invoiceStatus = "PAID";
    let providerCalled = false;
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post() {
                providerCalled = true;
            },
        },
    });
    const res = response();

    await handler(request, res);

    assert.equal(res.statusCode, 409);
    assert.equal(providerCalled, false);
    assert.equal(prisma.state.reservations, 0);
});

test("ambiguous Daraja network errors do not reset a reserved invoice to unpaid", async () => {
    const prisma = createPrisma();
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post() {
                throw new Error("Request timed out.");
            },
        },
    });
    const res = response();
    const originalError = console.error;
    console.error = () => {};

    try {
        await handler(request, res);
    } finally {
        console.error = originalError;
    }

    assert.equal(res.statusCode, 500);
    assert.equal(prisma.state.invoiceStatus, "PENDING_PAYMENT");
    assert.equal(prisma.state.transactions.length, 0);
});

test("a definite Daraja client rejection releases the invoice reservation", async () => {
    const prisma = createPrisma();
    const handler = createInitiateMpesaPaymentHandler({
        prismaClient: prisma,
        configuration,
        async accessTokenProvider() { return "access-token"; },
        httpClient: {
            async post() {
                throw Object.assign(new Error("Request rejected."), {
                    response: { status: 400 },
                });
            },
        },
    });
    const res = response();
    const originalError = console.error;
    console.error = () => {};

    try {
        await handler(request, res);
    } finally {
        console.error = originalError;
    }

    assert.equal(res.statusCode, 502);
    assert.equal(prisma.state.invoiceStatus, "UNPAID");
    assert.equal(prisma.state.transactions.length, 0);
});
