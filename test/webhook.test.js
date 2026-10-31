import assert from "node:assert/strict";
import test from "node:test";
import { createMpesaCallbackHandler } from "../src/controllers/webhookController.js";

const BASE_TRANSACTION = {
    id: "transaction-1",
    invoiceId: "invoice-1",
    merchantRequestId: "merchant-1",
    checkoutRequestId: "checkout-1",
    amountCents: 12500,
    mpesaReceiptCode: null,
    customerPhone: "254712345678",
    failureReason: null,
};

const BASE_INVOICE = {
    id: "invoice-1",
    status: "PENDING_PAYMENT",
    reading: {
        customer: {
            firstName: "Amina",
            lastName: "Wanjiku",
            phoneNumber: "254712345678",
        },
    },
};

function createResponse() {
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

function createFakePrisma({
    transaction = BASE_TRANSACTION,
    invoice = BASE_INVOICE,
    failInvoiceUpdate = false,
} = {}) {
    const state = {
        transaction: structuredClone(transaction),
        invoice: structuredClone(invoice),
        smsJobs: [],
    };
    let transactionQueue = Promise.resolve();

    const tx = {
        mPesaTransaction: {
            async updateMany({ where, data }) {
                const current = state.transaction;
                if (
                    current.id !== where.id
                    || current.mpesaReceiptCode !== where.mpesaReceiptCode
                    || current.failureReason !== where.failureReason
                ) {
                    return { count: 0 };
                }
                Object.assign(current, data);
                return { count: 1 };
            },
        },
        invoice: {
            async updateMany({ where, data }) {
                if (failInvoiceUpdate) throw new Error("Simulated invoice write failure.");
                if (
                    state.invoice.id !== where.id
                    || state.invoice.status !== where.status
                ) {
                    return { count: 0 };
                }
                Object.assign(state.invoice, data);
                return { count: 1 };
            },
            async findUnique() {
                return structuredClone(state.invoice);
            },
        },
        sMSQueue: {
            async upsert({ create }) {
                const data = create;
                state.smsJobs.push(structuredClone(data));
                return data;
            },
        },
    };

    const prisma = {
        mPesaTransaction: {
            async findUnique({ where }) {
                return state.transaction.checkoutRequestId === where.checkoutRequestId
                    ? structuredClone(state.transaction)
                    : null;
            },
        },
        async $transaction(work) {
            const previousTransaction = transactionQueue;
            let release;
            transactionQueue = new Promise((resolve) => {
                release = resolve;
            });
            await previousTransaction;

            const snapshot = structuredClone(state);
            try {
                return await work(tx);
            } catch (error) {
                state.transaction = snapshot.transaction;
                state.invoice = snapshot.invoice;
                state.smsJobs = snapshot.smsJobs;
                throw error;
            } finally {
                release();
            }
        },
    };

    return { prisma, state };
}

function makeCallback({
    resultCode = 0,
    resultDesc = "Success",
    checkoutRequestId = "checkout-1",
    merchantRequestId = "merchant-1",
    amount = 125,
    receipt = "QWERTY123",
} = {}) {
    const callback = {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: resultDesc,
    };

    if (resultCode === 0) {
        callback.CallbackMetadata = {
            Item: [
                { Name: "Amount", Value: amount },
                { Name: "MpesaReceiptCode", Value: receipt },
            ],
        };
    }

    return { Body: { stkCallback: callback } };
}

async function sendCallback(prisma, body) {
    const response = createResponse();
    const handler = createMpesaCallbackHandler(prisma);
    await handler({ body }, response);
    return response;
}

test("rejects malformed callback payloads before database access", async () => {
    let databaseCalled = false;
    const prisma = {
        mPesaTransaction: {
            async findUnique() {
                databaseCalled = true;
                return null;
            },
        },
    };

    const response = await sendCallback(prisma, { Body: {} });

    assert.equal(response.statusCode, 400);
    assert.equal(databaseCalled, false);
    assert.equal(response.body.ResultCode, 1);
});

test("successful callback marks invoice paid, records receipt and queues receipt SMS", async () => {
    const { prisma, state } = createFakePrisma();

    const response = await sendCallback(prisma, makeCallback());

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ResultCode, 0);
    assert.equal(state.transaction.mpesaReceiptCode, "QWERTY123");
    assert.equal(state.invoice.status, "PAID");
    assert.equal(state.smsJobs.length, 1);
    assert.equal(state.smsJobs[0].recipient, "254712345678");
    assert.match(state.smsJobs[0].message, /KSh 125\.00/);
    assert.doesNotMatch(state.smsJobs[0].message, /Amina Wanjiku/);
    assert.equal(state.smsJobs[0].notificationType, "payment_receipt");
    assert.equal(state.smsJobs[0].deduplicationKey, "payment-receipt:transaction-1");
});

test("failed payment records failure and returns pending invoice to unpaid", async () => {
    const { prisma, state } = createFakePrisma();

    const response = await sendCallback(
        prisma,
        makeCallback({ resultCode: 1032, resultDesc: "Request cancelled by user" }),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ResultCode, 0);
    assert.equal(state.transaction.failureReason, "Request cancelled by user");
    assert.equal(state.invoice.status, "UNPAID");
    assert.equal(state.smsJobs.length, 0);
});

test("rejects successful callback when the amount differs from the recorded transaction", async () => {
    const { prisma, state } = createFakePrisma();

    const response = await sendCallback(prisma, makeCallback({ amount: 124.99 }));

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ResultCode, 1);
    assert.equal(state.transaction.mpesaReceiptCode, null);
    assert.equal(state.invoice.status, "PENDING_PAYMENT");
    assert.equal(state.smsJobs.length, 0);
});

test("rejects successful callback without a receipt code", async () => {
    const { prisma, state } = createFakePrisma();
    const body = makeCallback();
    body.Body.stkCallback.CallbackMetadata.Item = [
        { Name: "Amount", Value: 125 },
    ];

    const response = await sendCallback(prisma, body);

    assert.equal(response.statusCode, 400);
    assert.equal(state.invoice.status, "PENDING_PAYMENT");
    assert.equal(state.smsJobs.length, 0);
});

test("rejects callbacks with unknown or mismatched provider request IDs", async () => {
    const { prisma, state } = createFakePrisma();

    const unknownResponse = await sendCallback(
        prisma,
        makeCallback({ checkoutRequestId: "unknown-checkout" }),
    );
    const mismatchResponse = await sendCallback(
        prisma,
        makeCallback({ merchantRequestId: "different-merchant" }),
    );

    assert.equal(unknownResponse.statusCode, 404);
    assert.equal(mismatchResponse.statusCode, 400);
    assert.equal(state.invoice.status, "PENDING_PAYMENT");
    assert.equal(state.smsJobs.length, 0);
});

test("duplicate successful callbacks do not enqueue duplicate SMS jobs", async () => {
    const { prisma, state } = createFakePrisma();

    const firstResponse = await sendCallback(prisma, makeCallback());
    const duplicateResponse = await sendCallback(prisma, makeCallback());

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(duplicateResponse.statusCode, 200);
    assert.equal(state.invoice.status, "PAID");
    assert.equal(state.smsJobs.length, 1);
});

test("concurrent duplicate callbacks only process the payment once", async () => {
    const { prisma, state } = createFakePrisma();

    const responses = await Promise.all([
        sendCallback(prisma, makeCallback()),
        sendCallback(prisma, makeCallback()),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    assert.equal(state.invoice.status, "PAID");
    assert.equal(state.smsJobs.length, 1);
});

test("does not queue receipt SMS when the customer has no phone number", async () => {
    const { prisma, state } = createFakePrisma({
        invoice: {
            ...BASE_INVOICE,
            reading: {
                customer: {
                    ...BASE_INVOICE.reading.customer,
                    phoneNumber: null,
                },
            },
        },
    });

    const response = await sendCallback(prisma, makeCallback());

    assert.equal(response.statusCode, 200);
    assert.equal(state.invoice.status, "PAID");
    assert.equal(state.smsJobs.length, 0);
});

test("rolls back transaction changes and returns an error if invoice reconciliation fails", async () => {
    const { prisma, state } = createFakePrisma({ failInvoiceUpdate: true });
    const originalError = console.error;
    console.error = () => {};
    try {
        const response = await sendCallback(prisma, makeCallback());

        assert.equal(response.statusCode, 500);
        assert.equal(response.body.ResultCode, 1);
        assert.equal(state.transaction.mpesaReceiptCode, null);
        assert.equal(state.invoice.status, "PENDING_PAYMENT");
        assert.equal(state.smsJobs.length, 0);
    } finally {
        console.error = originalError;
    }
});
