import { PrismaClient } from "@prisma/client";
import {
    comparePasswords,
    generateToken,
    hashPassword,
} from "../utils/auth.js";
import { normalizePhoneNumber } from "../utils/phoneSanitizer.js";

const prisma = new PrismaClient();
const MIN_PASSWORD_LENGTH = 8;

export function createLoginHandler(prismaClient = prisma) {
    return async function login(req, res) {
        const { phoneNumber: rawPhoneNumber, password } = req.body ?? {};
        const phoneNumber = normalizePhoneNumber(rawPhoneNumber);

        if (!phoneNumber || typeof password !== "string" || password.length === 0) {
            return res.status(400).json({
                error: "Provide a valid Kenyan mobile number and password.",
            });
        }

        try {
            const user = await prismaClient.user.findUnique({ where: { phoneNumber } });
            if (!user) {
                return res.status(401).json({ error: "Invalid phone number or password." });
            }

            const passwordMatches = user.passwordHash
                ? await comparePasswords(password, user.passwordHash)
                : password === user.phoneNumber;
            if (!passwordMatches) {
                return res.status(401).json({ error: "Invalid phone number or password." });
            }

            const firstLogin = !user.passwordHash;
            const mustChangePassword = password === user.phoneNumber;
            const passwordHash = firstLogin
                ? await hashPassword(user.phoneNumber)
                : user.passwordHash;
            if (firstLogin) {
                await prismaClient.user.update({
                    where: { id: user.id },
                    data: { passwordHash },
                });
            }

            return res.status(200).json({
                message: "Login successful.",
                token: generateToken(user, { mustChangePassword }),
                mustChangePassword,
                user: {
                    id: user.id,
                    accountNumber: user.accountNumber,
                    firstName: user.firstName,
                    middleName: user.middleName,
                    lastName: user.lastName,
                    phoneNumber: user.phoneNumber,
                    role: user.role,
                    location: user.location,
                },
            });
        } catch (error) {
            console.error("Login failed:", error);
            return res.status(500).json({ error: "Unable to complete login." });
        }
    };
}

export function createChangePasswordHandler(prismaClient = prisma) {
    return async function changePassword(req, res) {
        const { currentPassword, newPassword } = req.body ?? {};
        if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
            return res.status(400).json({
                error: "Provide both currentPassword and newPassword.",
            });
        }
        if (
            newPassword.length < MIN_PASSWORD_LENGTH
            || Buffer.byteLength(newPassword, "utf8") > 72
        ) {
            return res.status(400).json({
                error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters and no more than 72 UTF-8 bytes.`,
            });
        }

        try {
            const user = await prismaClient.user.findUnique({
                where: { id: req.user.id },
            });
            if (!user) {
                return res.status(404).json({ error: "User account was not found." });
            }

            const currentPasswordMatches = user.passwordHash
                ? await comparePasswords(currentPassword, user.passwordHash)
                : currentPassword === user.phoneNumber;
            if (!currentPasswordMatches) {
                return res.status(401).json({ error: "Current password is incorrect." });
            }
            if (newPassword === user.phoneNumber) {
                return res.status(400).json({
                    error: "Choose a password different from your phone number.",
                });
            }

            await prismaClient.user.update({
                where: { id: user.id },
                data: { passwordHash: await hashPassword(newPassword) },
            });
            return res.status(200).json({
                message: "Password changed. Sign in again with your new password.",
            });
        } catch (error) {
            console.error("Password change failed:", error);
            return res.status(500).json({ error: "Unable to change password." });
        }
    };
}

export const login = createLoginHandler();
export const changePassword = createChangePasswordHandler();
