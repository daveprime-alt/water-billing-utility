import express from "express";
import { importCustomers } from "../controllers/customerImportController.js";
import {
    handleSpreadsheetUploadError,
    spreadsheetUpload,
} from "../middleware/upload.js";
import { authenticateJWT, requirePasswordChangeComplete, requireRole } from "../middleware/authGuard.js";
import { blacklistToken } from "../utils/blacklistToken.js";
import {
    createAdminUser,
    deleteAdminManagedUser,
    removeUserPhone,
    resetUserPassword,
    updateUserPhone,
} from "../controllers/adminUserController.js";
import { smsAdminController } from "../controllers/smsAdminController.js";

const router = express.Router();

router.post(
    "/import-customers",
    authenticateJWT,
    requirePasswordChangeComplete,
    requireRole(["ADMIN"]),
    spreadsheetUpload,
    importCustomers,
);

router.post("/users", authenticateJWT, requirePasswordChangeComplete, requireRole(["ADMIN"]), createAdminUser);
router.delete("/users/:id", authenticateJWT, requirePasswordChangeComplete, requireRole(["ADMIN"]), deleteAdminManagedUser);
router.delete("/users/:id/phone", authenticateJWT, requirePasswordChangeComplete, requireRole(["ADMIN"]), removeUserPhone);
router.post("/users/:id/reset-password", authenticateJWT, requirePasswordChangeComplete, requireRole(["ADMIN"]), resetUserPassword);
router.patch("/users/:id/phone", authenticateJWT, requirePasswordChangeComplete, requireRole(["ADMIN"]), updateUserPhone);

const smsAdmin = [
    authenticateJWT,
    requirePasswordChangeComplete,
    requireRole(["ADMIN"]),
];
router.get("/sms/messages", ...smsAdmin, smsAdminController.listMessages);
router.post("/sms/messages/:id/retry", ...smsAdmin, smsAdminController.retryMessage);
router.get("/sms/announcement-recipients", ...smsAdmin, smsAdminController.listAnnouncementRecipients);
router.get("/sms/announcement-preferences", ...smsAdmin, smsAdminController.listAnnouncementPreferences);
router.patch("/sms/announcement-preferences/:userId", ...smsAdmin, smsAdminController.setAnnouncementOptOut);
router.get("/sms/campaigns", ...smsAdmin, smsAdminController.listCampaigns);
router.post("/sms/campaigns", ...smsAdmin, smsAdminController.createCampaign);
router.post("/sms/campaigns/:id/preview", ...smsAdmin, smsAdminController.previewCampaign);
router.post("/sms/campaigns/:id/confirm", ...smsAdmin, smsAdminController.confirmCampaign);
router.post("/sms/campaigns/:id/:action", ...smsAdmin, smsAdminController.updateCampaignState);
router.get("/sms/audit", ...smsAdmin, smsAdminController.listAudit);

router.post("/logout", authenticateJWT, requirePasswordChangeComplete, async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(400).json({ error: "Bad Request: Missing or malformed token." });
        }
        const token = authHeader.split(" ")[1];
        await blacklistToken(token);
        return res.status(200).json({ message: "Logout successful. Token successfully revoked." });
    } catch (error) {
        console.error("Logout execution error:", error);
        return res.status(500).json({ error: "Internal processing error during logout." });
    }
});

router.use(handleSpreadsheetUploadError);

export default router;
