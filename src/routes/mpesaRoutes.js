import express from 'express';
import { handleMpesaCallback } from '../controllers/webhookController.js';

const router = express.Router();

router.post('/server-callback', handleMpesaCallback);

export default router;