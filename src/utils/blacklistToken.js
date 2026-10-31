import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken"

const prisma = new PrismaClient();

export async function blacklistToken(token) {
    try {
        const decoded = jwt.decode(token);

        let expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

        if (decoded && decoded.exp) {
            expiresAt = new Date(decoded.exp * 1000);
        }

        await prisma.blacklistedToken.create({
            data: {
                token: token,
                expiresAt: expiresAt,
            },
        });
    } catch (error) {
        console.error("Failed to add token to blocklist:", error.message);
        throw new Error("Could not revoke authorization token.");
    }
}

export async function isTokenBlacklisted(token) {
    const record = await prisma.blacklistedToken.findUnique({
        where: { token: token },
    });
    return !!record;
}

export async function purgeExpiredBlacklistedTokens() {
    try {
        const result = await prisma.blacklistedToken.deleteMany({
            where: {
                expiresAt: { lt: new Date() },
            },
        });
        console.log(`Successfully purged ${result.count} expired token from blocklist.`);
    } catch (error) {
        console.error("Failed to clear expired blocklist entries:", error.message);
    }
}