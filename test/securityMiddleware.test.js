import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import {
    apiRateLimiter,
    corsMiddleware,
    mpesaCallbackRateLimiter,
} from "../src/middleware/security.js";

async function withServer(app, run) {
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

test("CORS allows configured origins and handles preflight requests", async () => {
    const originalOrigins = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = "https://billing.example.com";

    try {
        const app = express();
        app.use(corsMiddleware);
        app.get("/resource", (_req, res) => res.json({ ok: true }));

        await withServer(app, async (baseUrl) => {
            const allowed = await fetch(`${baseUrl}/resource`, {
                headers: { Origin: "https://billing.example.com" },
            });
            assert.equal(allowed.headers.get("access-control-allow-origin"), "https://billing.example.com");

            const blocked = await fetch(`${baseUrl}/resource`, {
                headers: { Origin: "https://untrusted.example" },
            });
            assert.equal(blocked.headers.get("access-control-allow-origin"), null);

            const preflight = await fetch(`${baseUrl}/resource`, {
                method: "OPTIONS",
                headers: {
                    Origin: "https://billing.example.com",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "authorization,content-type",
                },
            });
            assert.equal(preflight.status, 204);
            assert.equal(preflight.headers.get("access-control-allow-origin"), "https://billing.example.com");
        });
    } finally {
        if (originalOrigins === undefined) {
            delete process.env.CORS_ORIGINS;
        } else {
            process.env.CORS_ORIGINS = originalOrigins;
        }
    }
});

test("API rate limiter returns 429 after the configured request limit", async () => {
    const app = express();
    app.use("/api", apiRateLimiter);
    app.get("/api/resource", (_req, res) => res.json({ ok: true }));

    await withServer(app, async (baseUrl) => {
        let finalResponse;
        for (let request = 0; request < 101; request += 1) {
            finalResponse = await fetch(`${baseUrl}/api/resource`);
        }

        assert.equal(finalResponse.status, 429);
        assert.deepEqual(await finalResponse.json(), {
            error: "Too many requests. Please try again later.",
        });
    });

    test("M-Pesa callbacks use the dedicated limiter without consuming the general API limit", async () => {
        const app = express();
        app.use("/api/v1/payments/server-callback", mpesaCallbackRateLimiter);
        app.use("/api", apiRateLimiter);
        app.post("/api/v1/payments/server-callback", (_req, res) => res.sendStatus(200));

        await withServer(app, async (baseUrl) => {
            let finalResponse;
            for (let request = 0; request < 101; request += 1) {
                finalResponse = await fetch(`${baseUrl}/api/v1/payments/server-callback`, {
                    method: "POST",
                });
            }
            assert.equal(finalResponse.status, 200);
        });
    });
});
