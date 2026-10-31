import express from "express"
import dotenv from 'dotenv';
import {
    apiRateLimiter,
    corsMiddleware,
    mpesaCallbackRateLimiter,
} from "./src/middleware/security.js";
import morgan from "morgan";
import admin from "./src/routes/adminRoutes.js";
import userRoutes from "./src/routes/userRoutes.js";
import readingRoutes from "./src/routes/readingRoutes.js";
import invoiceRoutes from "./src/routes/invoiceRoutes.js";
import mpesaRoutes from "./src/routes/mpesaRoutes.js";
import helmet from "helmet";

dotenv.config();

const app = express();
const PORT = process.env.PORT;

app.use(helmet());
app.use(corsMiddleware);
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/v1/payments", mpesaCallbackRateLimiter);
app.use("/api", apiRateLimiter);
app.use("/api/admin", admin);
app.use("/api/users", userRoutes);
app.use("/api/readings", readingRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/v1/payments", mpesaRoutes);

app.get('/health', (req, res) => {
    return res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        usersScope: "Under 500 active connections"
    });
});

app.use((req, res) => {
    return res.status(404).json({ error: "Target API endpoint resource matches no active server components."});
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
})