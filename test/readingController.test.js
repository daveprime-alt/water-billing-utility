import assert from "node:assert/strict";
import test from "node:test";
import {
    createGetAllReadingsHandler,
    createUpdateReadingHandler,
} from "../src/controllers/readingController.js";

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

const NOW = new Date("2026-10-26T20:00:00.000Z");

function createPrisma(readings) {
    const calls = [];
    return {
        calls,
        meterReading: {
            async findMany(query) {
                calls.push(query);
                return readings;
            },
        },
    };
}

test("admin readings include billing, consumer, and reader display fields without phone numbers", async () => {
    const prisma = createPrisma([{
        id: "reading-1",
        previousReading: 100,
        currentReading: 145,
        unitsConsumed: 45,
        isRollover: false,
        dateRead: new Date("2026-10-20T08:30:00.000Z"),
        customerId: "consumer-1",
        readerId: "reader-1",
        customer: {
            id: "consumer-1",
            firstName: "Amina",
            middleName: "Wanjiku",
            lastName: "Njoroge",
            accountNumber: "WTR-001",
            phoneNumber: "254700000001",
            passwordHash: "must-not-be-included",
        },
        recordedBy: {
            id: "reader-1",
            firstName: "Peter",
            middleName: null,
            lastName: "Otieno",
            phoneNumber: "254700000002",
        },
        invoice: { billingMonth: "2026-10" },
    }]);
    const res = createResponse();

    await createGetAllReadingsHandler(prisma, () => NOW)(
        { user: { role: "ADMIN" } },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls[0].where, {});
    assert.deepEqual(res.body, [{
        id: "reading-1",
        previousReading: 100,
        currentReading: 145,
        consumptionUnits: 45,
        isRollover: false,
        billingMonth: "2026-10",
        createdAt: new Date("2026-10-20T08:30:00.000Z"),
        customer: {
            id: "consumer-1",
            name: "Amina Wanjiku Njoroge",
            accountNumber: "WTR-001",
        },
        recordedBy: {
            id: "reader-1",
            displayName: "Peter Otieno",
        },
    }]);
    assert.doesNotMatch(JSON.stringify(res.body), /phoneNumber|passwordHash|254700/);
});

test("reader readings remain restricted to the current billing month", async () => {
    const prisma = createPrisma([]);
    const res = createResponse();

    await createGetAllReadingsHandler(prisma, () => NOW)(
        { user: { role: "READER" } },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls[0].where, {
        dateRead: {
            gte: new Date("2026-10-01T00:00:00.000Z"),
            lt: new Date("2026-11-01T00:00:00.000Z"),
        },
    });
});

test("missing legacy reading and reader attribution data returns nullable fields", async () => {
    const prisma = createPrisma([{
        id: "legacy-reading",
        previousReading: null,
        currentReading: 145,
        unitsConsumed: null,
        isRollover: false,
        dateRead: new Date("2020-01-10T08:30:00.000Z"),
        customerId: "legacy-consumer",
        readerId: null,
        customer: {
            id: "legacy-consumer",
            firstName: "Amina",
            middleName: null,
            lastName: "Njoroge",
            accountNumber: null,
        },
        recordedBy: null,
        invoice: null,
    }]);
    const res = createResponse();

    await createGetAllReadingsHandler(prisma, () => NOW)(
        { user: { role: "ADMIN" } },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body[0].previousReading, null);
    assert.equal(res.body[0].consumptionUnits, null);
    assert.equal(res.body[0].billingMonth, null);
    assert.deepEqual(res.body[0].recordedBy, { id: null, displayName: null });
});

test("readers cannot correct a reading from a previous billing month", async () => {
    const oldReading = {
        id: "reading-1",
        customerId: "consumer-1",
        readerId: "reader-1",
        dateRead: new Date("2026-09-30T23:59:59.999Z"),
        previousReading: 100,
        currentReading: 145,
        unitsConsumed: 45,
        isRollover: false,
        invoice: null,
    };
    let updateCalled = false;
    const prisma = {
        meterReading: {
            async findUnique() {
                return { customerId: oldReading.customerId };
            },
        },
        async $transaction(work) {
            return work({
                async $queryRaw() {},
                meterReading: {
                    async findMany() {
                        return [oldReading];
                    },
                    async update() {
                        updateCalled = true;
                        return oldReading;
                    },
                },
            });
        },
    };
    const res = createResponse();

    await createUpdateReadingHandler(prisma, () => NOW)(
        {
            params: { id: oldReading.id },
            body: { currentReading: 150 },
            user: { id: "reader-1", role: "READER" },
        },
        res,
    );

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /current billing month/i);
    assert.equal(updateCalled, false);
});

test("readers can correct their own reading from the current billing month", async () => {
    const currentReading = {
        id: "reading-2",
        customerId: "consumer-1",
        readerId: "reader-1",
        dateRead: new Date("2026-10-26T08:30:00.000Z"),
        previousReading: 100,
        currentReading: 145,
        unitsConsumed: 45,
        isRollover: false,
        invoice: null,
    };
    let updateData;
    const prisma = {
        meterReading: {
            async findUnique() {
                return { customerId: currentReading.customerId };
            },
        },
        async $transaction(work) {
            return work({
                async $queryRaw() {},
                meterReading: {
                    async findMany() {
                        return [currentReading];
                    },
                    async update({ data }) {
                        updateData = data;
                        return { ...currentReading, ...data };
                    },
                },
                user: {
                    async findUnique() {
                        return { firstName: "Amina", phoneNumber: null };
                    },
                },
            });
        },
    };
    const res = createResponse();

    await createUpdateReadingHandler(prisma, () => NOW)(
        {
            params: { id: currentReading.id },
            body: { currentReading: 150 },
            user: { id: "reader-1", role: "READER" },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(updateData.currentReading, 150);
});
