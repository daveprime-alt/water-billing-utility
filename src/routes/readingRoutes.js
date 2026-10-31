import express from "express";
import { recordNewReading, getAllReadings, getReadingById, updateReading, deleteReading } from "../controllers/readingController.js";
import { authenticateJWT, requirePasswordChangeComplete, requireRole } from "../middleware/authGuard.js";
const router = express.Router();

router.post("/", authenticateJWT, requirePasswordChangeComplete, requireRole(['ADMIN', 'READER']), recordNewReading);
router.get("/", authenticateJWT, requirePasswordChangeComplete, requireRole(['ADMIN', 'READER']), getAllReadings);
router.get("/:id", authenticateJWT, requirePasswordChangeComplete, requireRole(['ADMIN', 'READER']), getReadingById);
router.put("/:id", authenticateJWT, requirePasswordChangeComplete, requireRole(['ADMIN', 'READER']), updateReading);
router.delete("/:id", authenticateJWT, requirePasswordChangeComplete, requireRole(['ADMIN', 'READER']), deleteReading);

export default router;