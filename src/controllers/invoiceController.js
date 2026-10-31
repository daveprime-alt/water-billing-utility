import { PrismaClient } from "@prisma/client";
import { createInitiateMpesaPaymentHandler } from "../services/mpesaPayment.js";

const prisma = new PrismaClient();

export const getInvoiceById = async (req, res) => {
    const { id } = req.params;
    try {
        const invoice = await prisma.invoice.findUnique({
            where: { id },
            include: { reading: { include: { customer: true } } },
        });
        if (!invoice) {
            return res.status(404).json({ error: "Invoice document not found." });
        }
        return res.status(200).json(invoice);
    } catch (error) {
        console.error("Failed to load invoice:", error);
        return res.status(500).json({ error: "Internal server error fetching invoice." });
    }
};

export const getAllInvoices = async (_req, res) => {
    try {
        const invoices = await prisma.invoice.findMany({
            orderBy: { createdAt: "desc" },
            include: {
                reading: {
                    include: {
                        customer: {
                            select: {
                                firstName: true,
                                lastName: true,
                                phoneNumber: true,
                                location: true,
                            },
                        },
                    },
                },
            },
        });
        return res.status(200).json(invoices);
    } catch (error) {
        console.error("Error in getAllInvoices:", error);
        return res.status(500).json({ error: "Failed to retrieve master invoice tracking lists." });
    }
};

export function createGetCustomerInvoicesHandler(prismaClient = prisma) {
    return async function getCustomerInvoices(req, res) {
        try {
            const invoices = await prismaClient.invoice.findMany({
                where: { reading: { customerId: req.user.id } },
                orderBy: { createdAt: "desc" },
                include: { reading: { select: { unitsConsumed: true } } },
            });
            return res.status(200).json(invoices.map(({ reading, ...invoice }) => ({
                ...invoice,
                consumptionUnits: reading?.unitsConsumed ?? null,
            })));
        } catch (error) {
            console.error("Error in getCustomerInvoices:", error);
            return res.status(500).json({ error: "Failed to retrieve personal billing accounts." });
        }
    };
}

export const getCustomerInvoices = createGetCustomerInvoicesHandler();

export const initiateMpesaPayment = createInitiateMpesaPaymentHandler({
    prismaClient: prisma,
});

export const cancelInvoice = async (req, res) => {
    const { id } = req.params;
    try {
        const cancelledBill = await prisma.invoice.update({
            where: { id },
            data: { status: "CANCELLED" },
        });
        return res.status(200).json({
            message: "Invoice state explicitly cancelled by Admin parameters.",
            cancelledBill,
        });
    } catch (error) {
        console.error("Failed to cancel invoice:", error);
        return res.status(500).json({
            error: "Failed to apply cancellation adjustments to target document indexes.",
        });
    }
};
