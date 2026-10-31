import { verifyToken } from '../utils/auth.js';
import { isTokenBlacklisted } from "../utils/blacklistToken.js";

export function createAuthenticateJWT({
    checkTokenRevoked = isTokenBlacklisted,
    verify = verifyToken,
} = {}) {
    return async function authenticateJWT(req, res, next) {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Access denied. Missing bearer authorization header context",
            });
        }

        const token = authHeader.split(" ")[1];

        let isRevoked;
        try {
            isRevoked = await checkTokenRevoked(token);
        } catch {
            console.error("Token revocation check failed.");
            return res.status(503).json({ error: "Authentication is temporarily unavailable." });
        }
        if (isRevoked) {
            return res.status(401).json({ error: "Unauthorized: This token has been revoked" });
        }

        try {
            const decodedPayload = verify(token);
            req.user = {
                id: decodedPayload.userId,
                number: decodedPayload.number,
                role: decodedPayload.role,
                mustChangePassword: decodedPayload.mustChangePassword === true,
            };
            return next();
        } catch {
            return res.status(403).json({ error: "Invalid or expired authentication token payload." });
        }
    };
}

export const authenticateJWT = createAuthenticateJWT();

export function requirePasswordChangeComplete(req, res, next) {
    if (req.user?.mustChangePassword) {
        return res.status(403).json({
            error: "Change your initial or reset password before using other endpoints.",
            changePasswordEndpoint: "POST /api/users/change-password",
        });
    }
    next();
}

export function requireRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Unauthorized access clearnace profile level.'})
            
        }
        next();
    };
}
