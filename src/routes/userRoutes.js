import express from "express";
import {
    getUserDirectory,
    getUserProfile,
    updateUserProfile,
    getUserById,
} from "../controllers/userController.js";
import { changePassword, login } from "../controllers/authController.js";
import { authenticateJWT, requirePasswordChangeComplete, requireRole } from "../middleware/authGuard.js";
import { loginRateLimiter } from "../middleware/security.js";

const router = express.Router();

router.post("/login", loginRateLimiter, login);
router.post("/change-password", authenticateJWT, changePassword);
router.get(
    "/directory",
    authenticateJWT,
    requirePasswordChangeComplete,
    requireRole(["ADMIN", "READER"]),
    getUserDirectory,
);
router.get("/profile", authenticateJWT, requirePasswordChangeComplete, getUserProfile);
router.put('/profile', authenticateJWT, requirePasswordChangeComplete, updateUserProfile);

router.get('/:id', authenticateJWT, requirePasswordChangeComplete, requireRole(['ADMIN', 'READER']), getUserById);

export default router;