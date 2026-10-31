import axios from "axios";
import { normalizePhoneNumber } from "../utils/phoneSanitizer.js";

function getDarajaBaseUrl(configuration) {
    return configuration.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
}

function getDarajaTimestamp(now = new Date()) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Nairobi",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(now)
            .map(({ type, value }) => [type, value]),
    );
    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function createDarajaPassword(shortcode, passkey, timestamp) {
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

async function getMpesaAccessToken(configuration, httpClient) {
    const consumerKey = configuration.MPESA_CONSUMER_KEY;
    const consumerSecret = configuration.MPESA_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) {
        throw new Error("Daraja consumer credentials are not configured.");
    }

    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const response = await httpClient.get(
        `${getDarajaBaseUrl(configuration)}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${credentials}` } },
    );
    if (typeof response.data?.access_token !== "string") {
        throw new Error("Daraja did not return an access token.");
    }
    return response.data.access_token;
}

export function createInitiateMpesaPaymentHandler({
    prismaClient,
    httpClient = axios,
    configuration = process.env,
    accessTokenProvider = () => getMpesaAccessToken(configuration, httpClient),
} = {}) {
    if (!prismaClient) throw new Error("A Prisma client is required for M-Pesa payments.");

    return async function initiateMpesaPayment(req, res) {
        const { id } = req.params;
        let reservationCreated = false;
        let invoiceAmountCents;

        async function releaseReservation() {
            const released = await prismaClient.invoice.updateMany({
                where: {
                    id,
                    status: "PENDING_PAYMENT",
                    closingReceivableCents: invoiceAmountCents,
                },
                data: { status: "UNPAID" },
            });
            reservationCreated = false;
            if (released.count !== 1) {
                console.error("Could not release the M-Pesa invoice reservation.", { invoiceId: id });
            }
        }

        try {
            const invoice = await prismaClient.invoice.findUnique({
                where: { id },
                include: { reading: { include: { customer: true } } },
            });
            if (!invoice) return res.status(404).json({ error: "Invoice not found." });

            const isAdmin = req.user.role === "ADMIN";
            const isInvoiceOwner = invoice.reading.customerId === req.user.id;
            if (!isAdmin && !isInvoiceOwner) {
                return res.status(403).json({ error: "You may only pay your own invoices." });
            }
            if (invoice.status !== "UNPAID" || invoice.closingReceivableCents <= 0) {
                return res.status(409).json({ error: "This invoice is not available for payment." });
            }
            const customerPhone = normalizePhoneNumber(req.body?.phoneNumber);
            if (!customerPhone) {
                return res.status(400).json({
                    error: "Provide a valid Kenyan mobile phone number for the M-Pesa prompt.",
                });
            }

            const shortcode = configuration.MPESA_BUSINESS_SHORTCODE;
            const passkey = configuration.MPESA_PASSKEY;
            const callbackUrl = configuration.MPESA_CALLBACK_URL;
            if (!shortcode || !passkey || !callbackUrl) {
                return res.status(500).json({ error: "Daraja payment configuration is incomplete." });
            }

            const token = await accessTokenProvider();
            invoiceAmountCents = invoice.closingReceivableCents;
            const reservation = await prismaClient.invoice.updateMany({
                where: {
                    id,
                    status: "UNPAID",
                    closingReceivableCents: invoiceAmountCents,
                },
                data: { status: "PENDING_PAYMENT" },
            });
            if (reservation.count !== 1) {
                return res.status(409).json({ error: "This invoice is not available for payment." });
            }
            reservationCreated = true;
            const timestamp = getDarajaTimestamp();
            const darajaResponse = await httpClient.post(
                `${getDarajaBaseUrl(configuration)}/mpesa/stkpush/v1/processrequest`,
                {
                    BusinessShortCode: shortcode,
                    Password: createDarajaPassword(shortcode, passkey, timestamp),
                    Timestamp: timestamp,
                    TransactionType: "CustomerPayBillOnline",
                    Amount: Math.round(invoiceAmountCents / 100),
                    PartyA: customerPhone,
                    PartyB: shortcode,
                    PhoneNumber: customerPhone,
                    CallBackUrl: callbackUrl,
                    AccountReference: `INV-${invoice.id.substring(0, 8).toUpperCase()}`,
                    TransactionDesc: `Water utility settlement bill month ${invoice.billingMonth}`,
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                },
            );

            const providerData = darajaResponse.data;
            if (providerData?.ResponseCode && providerData.ResponseCode !== "0") {
                await releaseReservation();
                return res.status(502).json({ error: "Daraja rejected the payment request." });
            }
            if (
                typeof providerData?.MerchantRequestID !== "string"
                || typeof providerData?.CheckoutRequestID !== "string"
            ) {
                return res.status(502).json({
                    error: "Daraja's response could not be confirmed; the invoice remains pending reconciliation.",
                });
            }

            await prismaClient.mPesaTransaction.create({
                data: {
                    invoiceId: id,
                    merchantRequestId: providerData.MerchantRequestID,
                    checkoutRequestId: providerData.CheckoutRequestID,
                    mpesaReceiptCode: null,
                    amountCents: invoiceAmountCents,
                    customerPhone,
                },
            });
            reservationCreated = false;
            return res.status(200).json({
                message: "M-Pesa payment prompt initiated. Complete the request on your phone; payment status updates after confirmation.",
                checkoutRequestId: providerData.CheckoutRequestID,
            });
        } catch (error) {
            console.error(
                "STK Push request failed.",
                { status: error.response?.status ?? null, code: error.code ?? null },
            );
            const responseStatus = error.response?.status;
            if (reservationCreated && responseStatus >= 400 && responseStatus < 500) {
                try {
                    await releaseReservation();
                } catch (releaseError) {
                    console.error("Failed to release a rejected M-Pesa payment reservation.", releaseError);
                }
            }
            const statusCode = responseStatus >= 400 && responseStatus < 500 ? 502 : 500;
            return res.status(statusCode).json({
                error: "Failed to process mobile wallet checkout. The payment state may require reconciliation.",
            });
        }
    };
}
