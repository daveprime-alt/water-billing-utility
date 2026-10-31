export const METER_MAX_READING = 100000;
export const MAX_ROLLOVER_CONSUMPTION = 5000;
export const TARIFF_PER_UNIT_CENTS = 11600;
const MAX_DATABASE_INT = 2_147_483_647;

export class BillingInputError extends Error {}
export class BillingAmountError extends Error {}

export function parseMeterReading(value) {
    if (typeof value !== "number" && typeof value !== "string") {
        throw new BillingInputError("Current meter reading must be a non-negative whole number.");
    }

    const reading = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
    if (!Number.isSafeInteger(reading) || reading < 0 || reading >= METER_MAX_READING) {
        throw new BillingInputError(`Current meter reading must be a whole number from 0 to ${METER_MAX_READING - 1}.`);
    }

    return reading;
}

export function calculateConsumption(previousReading, currentReading) {
    if (
        !Number.isSafeInteger(previousReading)
        || previousReading < 0
        || previousReading >= METER_MAX_READING
    ) {
        throw new BillingInputError("The previous meter reading is outside the supported meter range.");
    }

    const isRollover = currentReading < previousReading;
    const unitsConsumed = isRollover
        ? METER_MAX_READING - previousReading + currentReading
        : currentReading - previousReading;

    if (isRollover && unitsConsumed > MAX_ROLLOVER_CONSUMPTION) {
        throw new BillingInputError("Unrealistic index change detected. Verify meter unit data entry digits.");
    }

    return {
        previousReading,
        currentReading,
        unitsConsumed,
        isRollover,
        unitRateCents: TARIFF_PER_UNIT_CENTS,
        currentBillCents: unitsConsumed * TARIFF_PER_UNIT_CENTS,
    };
}

export function evaluateUsageSpike(currentUnits, previousReadings) {
    if (!Number.isSafeInteger(currentUnits) || currentUnits < 0) {
        throw new BillingInputError("Current usage must be a non-negative whole number.");
    }
    if (!Array.isArray(previousReadings)) {
        throw new BillingInputError("Previous readings must be provided as a list.");
    }
    if (previousReadings.some(
        (units) => !Number.isSafeInteger(units) || units < 0,
    )) {
        throw new BillingInputError("Previous usage values must be non-negative whole numbers.");
    }

    if (previousReadings.length === 0) {
        return {
            onHold: false,
            averageUnits: null,
            threshold: null,
            previousReadingsCount: 0,
        };
    }

    const totalUnits = previousReadings.reduce((total, units) => total + units, 0);
    const averageUnits = totalUnits / previousReadings.length;
    const threshold = averageUnits * 3;

    return {
        onHold: currentUnits > threshold,
        averageUnits,
        threshold,
        previousReadingsCount: previousReadings.length,
    };
}

export function invoiceBaseDue(invoice) {
    const baseDue = invoice.currentBillCents
        + (invoice.kplcAdjustmentCents ?? 0)
        - (invoice.paymentCreditsCents ?? 0);
    if (
        !Number.isSafeInteger(baseDue)
        || baseDue < -MAX_DATABASE_INT
        || baseDue > MAX_DATABASE_INT
    ) {
        throw new BillingAmountError("Invoice base amount is outside the supported amount range.");
    }
    return baseDue;
}

export function calculateInvoiceTotals(
    currentBillCents,
    openingReceivableCents,
    kplcAdjustmentCents = 0,
    paymentCreditsCents = 0,
    unitRateCents = TARIFF_PER_UNIT_CENTS,
) {
    const balanceForwardCents = openingReceivableCents - paymentCreditsCents;
    const closingReceivableCents = balanceForwardCents
        + currentBillCents
        + kplcAdjustmentCents;

    if (
        !Number.isSafeInteger(currentBillCents)
        || currentBillCents < 0
        || currentBillCents > MAX_DATABASE_INT
        || !Number.isSafeInteger(openingReceivableCents)
        || openingReceivableCents < -MAX_DATABASE_INT
        || openingReceivableCents > MAX_DATABASE_INT
        || !Number.isSafeInteger(paymentCreditsCents)
        || paymentCreditsCents < 0
        || paymentCreditsCents > MAX_DATABASE_INT
        || !Number.isSafeInteger(kplcAdjustmentCents)
        || kplcAdjustmentCents < -MAX_DATABASE_INT
        || kplcAdjustmentCents > MAX_DATABASE_INT
        || !Number.isSafeInteger(unitRateCents)
        || unitRateCents < 0
        || unitRateCents > MAX_DATABASE_INT
        || !Number.isSafeInteger(balanceForwardCents)
        || balanceForwardCents < -MAX_DATABASE_INT
        || balanceForwardCents > MAX_DATABASE_INT
        || !Number.isSafeInteger(closingReceivableCents)
        || closingReceivableCents < -MAX_DATABASE_INT
        || closingReceivableCents > MAX_DATABASE_INT
    ) {
        throw new BillingAmountError("Calculated invoice total is outside the supported amount range.");
    }

    return {
        currentBillCents,
        openingReceivableCents,
        paymentCreditsCents,
        kplcAdjustmentCents,
        closingReceivableCents,
        unitRateCents,
    };
}

export function addOutstandingBalance(currentBalance, invoice) {
    const nextBalance = currentBalance + invoiceBaseDue(invoice);
    if (
        !Number.isSafeInteger(nextBalance)
        || nextBalance < -MAX_DATABASE_INT
        || nextBalance > MAX_DATABASE_INT
    ) {
        throw new BillingAmountError("Accumulated unpaid balance is outside the supported amount range.");
    }
    return nextBalance;
}
