import assert from "node:assert/strict";
import test from "node:test";
import { createGetCustomerInvoicesHandler } from "../src/controllers/invoiceController.js";

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

test("consumer invoices include usage from the related meter reading", async () => {
    let query;
    const handler = createGetCustomerInvoicesHandler({
        invoice: {
            async findMany(value) {
                query = value;
                return [{
                    id: "invoice-1",
                    billingMonth: "2026-10",
                    reading: { unitsConsumed: 42 },
                }];
            },
        },
    });
    const res = response();

    await handler({ user: { id: "consumer-1" } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(query.where, { reading: { customerId: "consumer-1" } });
    assert.deepEqual(query.include, { reading: { select: { unitsConsumed: true } } });
    assert.deepEqual(res.body, [{
        id: "invoice-1",
        billingMonth: "2026-10",
        consumptionUnits: 42,
    }]);
});
