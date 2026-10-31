import assert from "node:assert/strict";
import test from "node:test";
import {
    addOutstandingBalance,
    BillingAmountError,
    BillingInputError,
    calculateConsumption,
    calculateInvoiceTotals,
    evaluateUsageSpike,
    invoiceBaseDue,
    parseMeterReading,
} from "../src/utils/billing.js";

test("meter readings must be whole numbers within the meter range", () => {
    assert.equal(parseMeterReading("125"), 125);
    assert.throws(() => parseMeterReading("125abc"), BillingInputError);
    assert.throws(() => parseMeterReading(-1), BillingInputError);
    assert.throws(() => parseMeterReading(100000), BillingInputError);
    assert.throws(() => parseMeterReading("abc"), BillingInputError);
});

test("calculates normal consumption and tariff charges", () => {
    assert.deepEqual(calculateConsumption(100, 130), {
        previousReading: 100,
        currentReading: 130,
        unitsConsumed: 30,
        isRollover: false,
        unitRateCents: 11600,
        currentBillCents: 348000,
    });
});

test("calculates valid meter rollover", () => {
    assert.deepEqual(calculateConsumption(99999, 0), {
        previousReading: 99999,
        currentReading: 0,
        unitsConsumed: 1,
        isRollover: true,
        unitRateCents: 11600,
        currentBillCents: 11600,
    });
});

test("rejects implausible rollover consumption", () => {
    assert.throws(() => calculateConsumption(90000, 0), BillingInputError);
});

test("usage exactly three times the previous average is not held", () => {
    assert.deepEqual(evaluateUsageSpike(60, [10, 20, 30]), {
        onHold: false,
        averageUnits: 20,
        threshold: 60,
        previousReadingsCount: 3,
    });
});

test("usage above three times the previous average is held", () => {
    assert.equal(evaluateUsageSpike(61, [10, 20, 30]).onHold, true);
});

test("usage below three times the previous average is not held", () => {
    assert.equal(evaluateUsageSpike(59, [10, 20, 30]).onHold, false);
});

test("usage with no previous readings is not automatically held", () => {
    assert.deepEqual(evaluateUsageSpike(100, []), {
        onHold: false,
        averageUnits: null,
        threshold: null,
        previousReadingsCount: 0,
    });
});

test("missing previous months are excluded from the average", () => {
    assert.deepEqual(evaluateUsageSpike(31, [10]), {
        onHold: true,
        averageUnits: 10,
        threshold: 30,
        previousReadingsCount: 1,
    });
});

test("positive usage above a zero historical average is held", () => {
    assert.equal(evaluateUsageSpike(1, [0, 0, 0]).onHold, true);
    assert.equal(evaluateUsageSpike(0, [0, 0, 0]).onHold, false);
});

test("usage spike calculation rejects invalid readings", () => {
    assert.throws(() => evaluateUsageSpike(-1, [10]), BillingInputError);
    assert.throws(() => evaluateUsageSpike(10, [-1]), BillingInputError);
});

test("unpaid invoices contribute their current bill and adjustment, not their carried opening balance", () => {
    const priorInvoice = {
        currentBillCents: 10000,
        openingReceivableCents: 5000,
        paymentCreditsCents: 0,
        kplcAdjustmentCents: 250,
        closingReceivableCents: 15250,
    };

    assert.equal(invoiceBaseDue(priorInvoice), 10250);
    assert.equal(addOutstandingBalance(2500, priorInvoice), 12750);
});

test("payment credits reduce the amount carried forward from an unpaid invoice", () => {
    assert.equal(invoiceBaseDue({
        currentBillCents: 10000,
        kplcAdjustmentCents: 250,
        paymentCreditsCents: 3000,
    }), 7250);
});

test("invoice totals calculate balance forward and closing receivable in integer cents", () => {
    assert.deepEqual(calculateInvoiceTotals(10000, 2000, 500, 300), {
        currentBillCents: 10000,
        openingReceivableCents: 2000,
        paymentCreditsCents: 300,
        kplcAdjustmentCents: 500,
        closingReceivableCents: 12200,
        unitRateCents: 11600,
    });
    assert.throws(
        () => calculateInvoiceTotals(2_147_483_647, 1),
        BillingAmountError,
    );
});

test("invoice calculations preserve account credits as negative closing receivables", () => {
    assert.deepEqual(calculateInvoiceTotals(5000, -3000), {
        currentBillCents: 5000,
        openingReceivableCents: -3000,
        paymentCreditsCents: 0,
        kplcAdjustmentCents: 0,
        closingReceivableCents: 2000,
        unitRateCents: 11600,
    });
});

test("invoice payment credits are positive cents subtracted from the opening receivable", () => {
    assert.deepEqual(calculateInvoiceTotals(1000, 5000, 0, 2000), {
        currentBillCents: 1000,
        openingReceivableCents: 5000,
        paymentCreditsCents: 2000,
        kplcAdjustmentCents: 0,
        closingReceivableCents: 4000,
        unitRateCents: 11600,
    });
});

test("August workbook example converts to integer cents without floating-point drift", () => {
    const totals = calculateInvoiceTotals(58000, 464236, 28520);

    assert.equal(totals.currentBillCents, 58000);
    assert.equal(totals.openingReceivableCents, 464236);
    assert.equal(totals.kplcAdjustmentCents, 28520);
    assert.equal(totals.closingReceivableCents, 550756);
    assert.equal(totals.closingReceivableCents / 100, 5507.56);
});
