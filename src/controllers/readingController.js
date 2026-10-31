import { PrismaClient } from "@prisma/client";
import {
    addOutstandingBalance,
    BillingAmountError,
    BillingInputError,
    calculateConsumption,
    calculateInvoiceTotals,
    evaluateUsageSpike,
    parseMeterReading,
} from "../utils/billing.js";
import { enqueueSms, formatNairobiDate } from "../utils/sms.js";

const prisma = new PrismaClient();

class MonthlyReadingExistsError extends Error {}
class ReadingNotFoundError extends Error {}
class SettledInvoiceCorrectionError extends Error {}
class ReadingCannotBeDeletedError extends Error {}

const getCurrentMonthBounds = (now = new Date()) => {
    const year = now.getUTCFullYear();
    const monthIndex = now.getUTCMonth();
    const month = String(monthIndex + 1).padStart(2, "0");

    return {
        billingMonthStr: `${year}-${month}`,
        startOfMonth: new Date(Date.UTC(year, monthIndex, 1)),
        startOfNextMonth: new Date(Date.UTC(year, monthIndex + 1, 1)),
    };
};

async function checkForUsageSpike(tx, customerId, currentUnits, now) {
    const { startOfMonth } = getCurrentMonthBounds(now);
    const startOfThreeMonthsAgo = new Date(Date.UTC(
        startOfMonth.getUTCFullYear(),
        startOfMonth.getUTCMonth() - 3,
        1,
    ));

    const previousReadings = await tx.meterReading.findMany({
        where: {
            customerId,
            dateRead: {
                gte: startOfThreeMonthsAgo,
                lt: startOfMonth,
            },
        },
        orderBy: [{ dateRead: "desc" }, { id: "desc" }],
        select: { unitsConsumed: true },
    });

    return evaluateUsageSpike(
        currentUnits,
        previousReadings.map((reading) => reading.unitsConsumed),
    );
}

async function lockCustomerReadingSequence(tx, customerId) {
    await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
            hashtext('water-billing-reading-sequence'),
            hashtext(${customerId})
        )
    `;
}

function isInvoiceTotalsChanged(invoice, totals) {
    return invoice.currentBillCents !== totals.currentBillCents
        || invoice.openingReceivableCents !== totals.openingReceivableCents
        || invoice.paymentCreditsCents !== totals.paymentCreditsCents
        || invoice.kplcAdjustmentCents !== totals.kplcAdjustmentCents
        || invoice.closingReceivableCents !== totals.closingReceivableCents
        || invoice.unitRateCents !== totals.unitRateCents;
}

function handleBillingError(res, error) {
    if (error instanceof BillingInputError) {
        return res.status(400).json({ error: error.message });
    }
    if (error instanceof BillingAmountError) {
        return res.status(422).json({ error: error.message });
    }
    if (error instanceof MonthlyReadingExistsError) {
        return res.status(409).json({ error: error.message });
    }
    if (error instanceof ReadingNotFoundError) {
        return res.status(404).json({ error: "Reading record was not found." });
    }
    if (error instanceof SettledInvoiceCorrectionError) {
        return res.status(409).json({ error: error.message });
    }
    if (error instanceof ReadingCannotBeDeletedError) {
        return res.status(409).json({ error: error.message });
    }
    return null;
}

export const recordNewReading = async (req, res) => {
    const { customerId, currentReading } = req.body;
    if (typeof customerId !== "string" || customerId.trim() === "") {
        return res.status(400).json({ error: "A customer ID is required." });
    }

    let newReading;
    try {
        newReading = parseMeterReading(currentReading);
    } catch (error) {
        return handleBillingError(res, error);
    }

    const now = new Date();
    const { billingMonthStr, startOfMonth, startOfNextMonth } = getCurrentMonthBounds(now);
    const dueDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    try {
        const result = await prisma.$transaction(async (tx) => {
            await lockCustomerReadingSequence(tx, customerId);

            const existingReading = await tx.meterReading.findFirst({
                where: {
                    customerId,
                    dateRead: {
                        gte: startOfMonth,
                        lt: startOfNextMonth,
                    },
                },
                select: { id: true },
            });
            if (existingReading) {
                throw new MonthlyReadingExistsError(
                    "A reading for this customer has already been logged for the current billing month.",
                );
            }

            const lastReading = await tx.meterReading.findFirst({
                where: { customerId },
                orderBy: [{ dateRead: "desc" }, { id: "desc" }],
            });
            const calculation = calculateConsumption(lastReading?.currentReading ?? 0, newReading);
            const usageSpike = await checkForUsageSpike(
                tx,
                customerId,
                calculation.unitsConsumed,
                now,
            );

            const unpaidInvoices = await tx.invoice.findMany({
                where: {
                    status: "UNPAID",
                    reading: { is: { customerId } },
                },
                select: {
                    currentBillCents: true,
                    kplcAdjustmentCents: true,
                },
            });
            const openingReceivableCents = unpaidInvoices.reduce(
                (balance, invoice) => addOutstandingBalance(balance, invoice),
                0,
            );
            const totals = calculateInvoiceTotals(
                calculation.currentBillCents,
                openingReceivableCents,
                0,
                0,
                calculation.unitRateCents,
            );

            const reading = await tx.meterReading.create({
                data: {
                    customerId,
                    readerId: req.user.id,
                    previousReading: calculation.previousReading,
                    currentReading: calculation.currentReading,
                    unitsConsumed: calculation.unitsConsumed,
                    isRollover: calculation.isRollover,
                    dateRead: now,
                },
            });

            const invoice = await tx.invoice.create({
                data: {
                    readingId: reading.id,
                    ...totals,
                    unitRateCents: calculation.unitRateCents,
                    status: usageSpike.onHold ? "ADMIN_HOLD" : "UNPAID",
                    billingMonth: billingMonthStr,
                    dueDate,
                },
                include: {
                    reading: {
                        include: {
                            customer: {
                            select: { firstName: true, phoneNumber: true },
                            },
                        },
                    },
                },
            });

            if (invoice.reading.customer.phoneNumber && !usageSpike.onHold) {
                await enqueueSms(tx, {
                    recipient: invoice.reading.customer.phoneNumber,
                    notificationType: "new_bill",
                    deduplicationKey: `new-bill:${invoice.id}`,
                    templateData: {
                        billingMonth: billingMonthStr,
                        amountCents: totals.closingReceivableCents,
                        dueDate: formatNairobiDate(dueDate),
                    },
                });
            }

            return { reading, invoice, usageSpike };
        });

        return res.status(201).json({
            message: result.usageSpike.onHold
                ? "Meter reading logged; invoice placed on hold for admin review."
                : "Meter reading logged and invoice created.",
            invoice: result.invoice,
            usageReview: {
                onHold: result.usageSpike.onHold,
                averageUnits: result.usageSpike.averageUnits,
                threshold: result.usageSpike.threshold,
                previousReadingsCount: result.usageSpike.previousReadingsCount,
            },
        });
    } catch (error) {
        const handled = handleBillingError(res, error);
        if (handled) return handled;

        console.error("Error recording meter reading:", error);
        return res.status(500).json({
            error: "Failed to record the meter reading and create its invoice.",
        });
    }
};

function displayName(user) {
    if (!user) return null;
    const name = [user.firstName, user.middleName, user.lastName]
        .filter((part) => typeof part === "string" && part.trim() !== "")
        .join(" ");
    return name || null;
}

export function createGetAllReadingsHandler(prismaClient = prisma, now = () => new Date()) {
    return async function getAllReadings(req, res) {
        const { startOfMonth, startOfNextMonth } = getCurrentMonthBounds(now());
        const where = {};
        if (req.user.role === "READER") {
            where.dateRead = {
                gte: startOfMonth,
                lt: startOfNextMonth,
            };
        }

        try {
            const readings = await prismaClient.meterReading.findMany({
                where,
                orderBy: [{ dateRead: "desc" }, { id: "desc" }],
                select: {
                    id: true,
                    previousReading: true,
                    currentReading: true,
                    unitsConsumed: true,
                    isRollover: true,
                    dateRead: true,
                    customerId: true,
                    readerId: true,
                    customer: {
                        select: {
                            id: true,
                            firstName: true,
                            middleName: true,
                            lastName: true,
                            accountNumber: true,
                        },
                    },
                    recordedBy: {
                        select: {
                            id: true,
                            firstName: true,
                            middleName: true,
                            lastName: true,
                        },
                    },
                    invoice: {
                        select: { billingMonth: true },
                    },
                },
            });
            return res.status(200).json(readings.map((reading) => ({
                id: reading.id,
                previousReading: reading.previousReading ?? null,
                currentReading: reading.currentReading,
                consumptionUnits: reading.unitsConsumed ?? null,
                isRollover: reading.isRollover,
                billingMonth: reading.invoice?.billingMonth ?? null,
                createdAt: reading.dateRead,
                customer: {
                    id: reading.customer?.id ?? reading.customerId ?? null,
                    name: displayName(reading.customer),
                    accountNumber: reading.customer?.accountNumber ?? null,
                },
                recordedBy: reading.recordedBy
                    ? {
                        id: reading.recordedBy.id ?? reading.readerId ?? null,
                        displayName: displayName(reading.recordedBy),
                    }
                    : {
                        id: reading.readerId ?? null,
                        displayName: null,
                    },
            })));
        } catch (error) {
            console.error("Error fetching meter readings:", error);
            return res.status(500).json({ error: "Failed to load meter readings." });
        }
    };
}

export const getAllReadings = createGetAllReadingsHandler();

export const getReadingById = async (req, res) => {
    const { id } = req.params;
    const { startOfMonth, startOfNextMonth } = getCurrentMonthBounds();

    try {
        const reading = await prisma.meterReading.findUnique({
            where: { id },
            include: {
                customer: {
                    select: {
                        firstName: true,
                        lastName: true,
                        accountNumber: true,
                        phoneNumber: true,
                    },
                },
            },
        });

        if (!reading) {
            return res.status(404).json({ error: "Reading record was not found." });
        }

        if (
            req.user.role === "READER"
            && (reading.dateRead < startOfMonth || reading.dateRead >= startOfNextMonth)
        ) {
            return res.status(403).json({
                error: "Readers can only view readings from the current billing month.",
            });
        }
        return res.status(200).json(reading);
    } catch (error) {
        console.error("Error fetching meter reading:", error);
        return res.status(500).json({ error: "Failed to load the requested reading." });
    }
};

export function createUpdateReadingHandler(prismaClient = prisma, now = () => new Date()) {
    return async function updateReading(req, res) {
        const { id } = req.params;
        let requestedReading;
        try {
            requestedReading = parseMeterReading(req.body.currentReading);
        } catch (error) {
            return handleBillingError(res, error);
        }

        try {
            const initialReading = await prismaClient.meterReading.findUnique({
                where: { id },
                select: { customerId: true },
            });
            if (!initialReading) {
                return res.status(404).json({ error: "Reading record was not found." });
            }

            const result = await prismaClient.$transaction(async (tx) => {
                await lockCustomerReadingSequence(tx, initialReading.customerId);

                const readings = await tx.meterReading.findMany({
                    where: { customerId: initialReading.customerId },
                    orderBy: [{ dateRead: "asc" }, { id: "asc" }],
                    include: { invoice: true },
                });
                const targetIndex = readings.findIndex((reading) => reading.id === id);
                if (targetIndex < 0) throw new ReadingNotFoundError();

                const target = readings[targetIndex];
                if (req.user.role === "READER") {
                    if (target.readerId !== req.user.id) {
                        return { forbidden: true };
                    }
                    const { startOfMonth, startOfNextMonth } = getCurrentMonthBounds(now());
                    if (target.dateRead < startOfMonth || target.dateRead >= startOfNextMonth) {
                        return { outsideCurrentMonth: true };
                    }
                }

                const customer = await tx.user.findUnique({
                    where: { id: target.customerId },
                    select: { firstName: true, phoneNumber: true },
                });
                if (!customer) throw new ReadingNotFoundError();

                let outstandingBalance = readings.slice(0, targetIndex).reduce(
                    (balance, reading) => reading.invoice?.status === "UNPAID"
                        ? addOutstandingBalance(balance, reading.invoice)
                        : balance,
                    0,
                );
                let previousReading = targetIndex > 0
                    ? readings[targetIndex - 1].currentReading
                    : 0;
                const correctedInvoices = [];
                let updatedTarget;

                for (let index = targetIndex; index < readings.length; index += 1) {
                    const reading = readings[index];
                    const current = reading.id === id ? requestedReading : reading.currentReading;
                    const calculation = calculateConsumption(previousReading, current);
                    const readingChanged = reading.previousReading !== calculation.previousReading
                        || reading.currentReading !== calculation.currentReading
                        || reading.unitsConsumed !== calculation.unitsConsumed
                        || reading.isRollover !== calculation.isRollover;

                    const updatedReading = readingChanged
                        ? await tx.meterReading.update({
                            where: { id: reading.id },
                            data: {
                                previousReading: calculation.previousReading,
                                currentReading: calculation.currentReading,
                                unitsConsumed: calculation.unitsConsumed,
                                isRollover: calculation.isRollover,
                            },
                        })
                        : reading;
                    if (reading.id === id) updatedTarget = updatedReading;

                    if (reading.invoice) {
                        const invoice = reading.invoice;
                        const totals = calculateInvoiceTotals(
                            calculation.currentBillCents,
                            outstandingBalance,
                            invoice.kplcAdjustmentCents,
                            invoice.paymentCreditsCents,
                            calculation.unitRateCents,
                        );
                        const invoiceChanged = isInvoiceTotalsChanged(invoice, totals);

                        if (
                            invoiceChanged
                            && invoice.status !== "UNPAID"
                            && invoice.status !== "CANCELLED"
                        ) {
                            throw new SettledInvoiceCorrectionError(
                                `Reading correction would change ${invoice.status.toLowerCase()} invoice ${invoice.id}. Reconcile that invoice before changing the reading.`,
                            );
                        }

                        if (invoiceChanged) {
                            await tx.invoice.update({
                                where: { id: invoice.id },
                                data: totals,
                            });
                            if (invoice.status === "UNPAID") {
                                correctedInvoices.push({
                                    billingMonth: invoice.billingMonth,
                                    unitsConsumed: calculation.unitsConsumed,
                                    closingReceivableCents: totals.closingReceivableCents,
                                });
                            }
                        }

                        if (invoice.status === "UNPAID") {
                            outstandingBalance = addOutstandingBalance(outstandingBalance, totals);
                        }
                    }

                    previousReading = current;
                }

                return { reading: updatedTarget, correctedInvoices: correctedInvoices.length };
            });

            if (result.forbidden) {
                return res.status(403).json({
                    error: "Readers may only correct readings they recorded.",
                });
            }
            if (result.outsideCurrentMonth) {
                return res.status(403).json({
                    error: "Readers may only correct readings from the current billing month.",
                });
            }

            return res.status(200).json({
                message: "Reading and affected unpaid invoices recalculated.",
                reading: result.reading,
                correctedInvoices: result.correctedInvoices,
            });
        } catch (error) {
            const handled = handleBillingError(res, error);
            if (handled) return handled;

            console.error("Error recalculating readings and invoices:", error);
            return res.status(500).json({
                error: "Failed to correct the reading and recalculate its billing sequence.",
            });
        }
    }
}

export const updateReading = createUpdateReadingHandler();

export const deleteReading = async (req, res) => {
    const { id } = req.params;

    try {
        const initialReading = await prisma.meterReading.findUnique({
            where: { id },
            select: { customerId: true },
        });
        if (!initialReading) {
            return res.status(404).json({ error: "Reading record was not found." });
        }

        const result = await prisma.$transaction(async (tx) => {
            await lockCustomerReadingSequence(tx, initialReading.customerId);
            const readings = await tx.meterReading.findMany({
                where: { customerId: initialReading.customerId },
                orderBy: [{ dateRead: "asc" }, { id: "asc" }],
                include: { invoice: { select: { id: true } } },
            });
            const targetIndex = readings.findIndex((reading) => reading.id === id);
            if (targetIndex < 0) throw new ReadingNotFoundError();

            const target = readings[targetIndex];
            if (req.user.role === "READER" && target.readerId !== req.user.id) {
                return { forbidden: true };
            }
            if (target.invoice || targetIndex < readings.length - 1) {
                throw new ReadingCannotBeDeletedError(
                    "This reading has an invoice or later readings that depend on it. Correct it instead of deleting it.",
                );
            }

            await tx.meterReading.delete({ where: { id } });
            return { deleted: true };
        });

        if (result.forbidden) {
            return res.status(403).json({
                error: "Readers may only delete readings they recorded.",
            });
        }
        return res.status(200).json({ message: "Reading deleted." });
    } catch (error) {
        const handled = handleBillingError(res, error);
        if (handled) return handled;

        console.error("Error deleting meter reading:", error);
        return res.status(500).json({ error: "Failed to delete the reading." });
    }
};
