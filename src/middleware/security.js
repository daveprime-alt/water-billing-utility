import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { xFrameOptions } from "helmet";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function isAllowedOrigin(origin) {
    const configuredOrigins = process.env.CORS_ORIGINS
        ?? (process.env.NODE_ENV === "production"
            ? ""
            : "https://water-billing-utility.vercel.app,http://localhost:5173,http://");
    const allowedOrigins = new Set(
        configuredOrigins.split(",").map((value) => value.trim()).filter(Boolean),
    );
    return allowedOrigins.has(origin);
}

// src/middleware/security.js

export function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    if (!origin) {
        return next();
    }

    if (isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        res.setHeader("Access-Control-Allow-Credentials", "true");

        if (req.method === "OPTIONS") {
            return res.sendStatus(204);
        }

        return next(); 
    }

    return res.status(403).json({ error: "CORS policy: Origin not allowed." });
}


export const apiRateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
    skip: (req) => req.path === "/v1/payments/server-callback",
});

export const mpesaCallbackRateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many payment callbacks. Please try again later." },
});

export const loginRateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please try again later." },
});
