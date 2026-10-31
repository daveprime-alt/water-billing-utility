import { PrismaClient } from "@prisma/client";
import { enqueueSms } from "../utils/sms.js";

function getCallbackMetadata(items, name) {
    return items.find((item) => item?.Name === name)?.Value;
}

function readPaidAmountCents(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const cents = Math.round(amount * 100);
    return Number.isSafeInteger(cents) ? cents : null;
}

function darajaAcknowledgement(resultCode, resultDesc) {
    return { ResultCode: resultCode, ResultDesc: resultDesc };
}

export function createMpesaCallbackHandler(prismaClient) {
    return async (req, res) => {
        const callback = req.body?.Body?.stkCallback;
        if (
            !callback
            || typeof callback.CheckoutRequestID !== "string"
            || callback.CheckoutRequestID.trim() === ""
            || typeof callback.MerchantRequestID !== "string"
            || callback.MerchantRequestID.trim() === ""
            || !Number.isInteger(callback.ResultCode)
        ) {
            return res.status(400).json(
                darajaAcknowledgement(1, "Invalid or missing callback payload."),
            );
        }

        const {
            MerchantRequestID: merchantRequestId,
            CheckoutRequestID: checkoutRequestId,
            ResultCode: resultCode,
            ResultDesc: resultDescription,
            CallbackMetadata: callbackMetadata,
        } = callback;

        try {
            const existingTransaction = await prismaClient.mPesaTransaction.findUnique({
                where: { checkoutRequestId },
            });

            if (!existingTransaction) {
                console.error("Received M-Pesa callback for an unknown checkout request.");
                return res.status(404).json(
                    darajaAcknowledgement(1, "Transaction reference not found."),
                );
            }

            if (existingTransaction.merchantRequestId !== merchantRequestId) {
                console.error("M-Pesa callback request identifiers did not match.");
                return res.status(400).json(
                    darajaAcknowledgement(1, "Transaction reference mismatch."),
                );
            }

            if (
                existingTransaction.mpesaReceiptCode !== null
                || existingTransaction.failureReason !== null
            ) {
                return res.status(200).json(
                    darajaAcknowledgement(0, "Callback already processed."),
                );
            }

            if (resultCode !== 0) {
                const failureReason = String(
                    resultDescription || "Payment was not completed.",
                ).slice(0, 500);

                const processed = await prismaClient.$transaction(async (tx) => {
                    const transactionUpdate = await tx.mPesaTransaction.updateMany({
                        where: {
                            id: existingTransaction.id,
                            mpesaReceiptCode: null,
                            failureReason: null,
                        },
                        data: { failureReason },
                    });

                    if (transactionUpdate.count === 0) return false;

                    const invoiceUpdate = await tx.invoice.updateMany({
                        where: {
                            id: existingTransaction.invoiceId,
                            status: "PENDING_PAYMENT",
                        },
                        data: { status: "UNPAID" },
                    });

                    if (invoiceUpdate.count !== 1) {
                        throw new Error("Invoice state did not match the pending payment.");
                    }

                    return true;
                });

                return res.status(200).json(
                    darajaAcknowledgement(
                        0,
                        processed ? "Payment failure recorded." : "Callback already processed.",
                    ),
                );
            }

            const metadataItems = Array.isArray(callbackMetadata?.Item)
                ? callbackMetadata.Item
                : [];
            const receiptCode = getCallbackMetadata(metadataItems, "MpesaReceiptCode");
            const amountCents = readPaidAmountCents(
                getCallbackMetadata(metadataItems, "Amount"),
            );

            if (typeof receiptCode !== "string" || receiptCode.trim() === "") {
                return res.status(400).json(
                    darajaAcknowledgement(
                        1,
                        "Successful callback is missing its receipt code.",
                    ),
                );
            }

            if (amountCents === null || amountCents !== existingTransaction.amountCents) {
                console.error("M-Pesa callback amount did not match the recorded transaction.");
                return res.status(400).json(
                    darajaAcknowledgement(1, "Transaction amount validation failed."),
                );
            }

            const processed = await prismaClient.$transaction(async (tx) => {
                const transactionUpdate = await tx.mPesaTransaction.updateMany({
                    where: {
                        id: existingTransaction.id,
                        mpesaReceiptCode: null,
                        failureReason: null,
                    },
                    data: { mpesaReceiptCode: receiptCode.trim() },
                });

                if (transactionUpdate.count === 0) return false;

                const invoiceUpdate = await tx.invoice.updateMany({
                    where: {
                        id: existingTransaction.invoiceId,
                        status: "PENDING_PAYMENT",
                    },
                    data: { status: "PAID" },
                });

                if (invoiceUpdate.count !== 1) {
                    throw new Error("Invoice state did not match the pending payment.");
                }

                const invoice = await tx.invoice.findUnique({
                    where: { id: existingTransaction.invoiceId },
                    include: {
                        reading: {
                            include: {
                                customer: {
                                    select: {
                                        firstName: true,
                                        lastName: true,
                                        phoneNumber: true,
                                    },
                                },
                            },
                        },
                    },
                });

                if (invoice?.reading.customer.phoneNumber) {
                    await enqueueSms(tx, {
                        recipient: invoice.reading.customer.phoneNumber,
                        notificationType: "payment_receipt",
                        deduplicationKey: `payment-receipt:${existingTransaction.id}`,
                        templateData: {
                            amountCents: existingTransaction.amountCents,
                            receiptCode: receiptCode.trim(),
                        },
                    });
                }

                return true;
            });

            return res.status(200).json(
                darajaAcknowledgement(
                    0,
                    processed ? "Payment completed successfully." : "Callback already processed.",
                ),
            );
        } catch (error) {
            console.error("M-Pesa callback processing failed:", error);
            return res.status(500).json(
                darajaAcknowledgement(1, "Callback processing failed."),
            );
        }
    };
}

const prisma = new PrismaClient();
export const handleMpesaCallback = createMpesaCallbackHandler(prisma);
