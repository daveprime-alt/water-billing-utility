import express from "express";
import { getAllInvoices, getInvoiceById, getCustomerInvoices, initiateMpesaPayment, cancelInvoice} from "../controllers/invoiceController.js";
import { authenticateJWT, requirePasswordChangeComplete, requireRole } from "../middleware/authGuard.js";

const router = express.Router();

router.get(
    '/',
    authenticateJWT,
    requirePasswordChangeComplete,
    requireRole(['ADMIN']),
    getAllInvoices
);

router.put(
    '/:id/cancel',
    authenticateJWT,
    requirePasswordChangeComplete,
    requireRole(['ADMIN']),
    cancelInvoice
);

router.get(
    '/my-bills',
    authenticateJWT,
    requirePasswordChangeComplete,
    getCustomerInvoices
);

router.post(
    '/:id/pay',
    authenticateJWT,
    requirePasswordChangeComplete,
    initiateMpesaPayment
)

export default router;