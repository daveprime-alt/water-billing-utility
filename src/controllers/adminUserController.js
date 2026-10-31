import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../utils/auth.js";
import { normalizePhoneNumber } from "../utils/phoneSanitizer.js";

const prisma = new PrismaClient();
const ALLOWED_ROLES = new Set(["CONSUMER", "READER"]);

function validName(value) {
    return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;
}

function publicUser(user) {
    const { passwordHash, ...safeUser } = user;
    return safeUser;
}

export function createAdminUserHandler(prismaClient = prisma) {
    return async function createAdminUser(req, res) {
        const {
            firstName,
            middleName = null,
            lastName,
            phoneNumber: rawPhoneNumber,
            role = "CONSUMER",
            accountNumber = null,
            location = null,
        } = req.body ?? {};
        const phoneNumber = normalizePhoneNumber(rawPhoneNumber);

        if (!validName(firstName) || !validName(lastName)) {
            return res.status(400).json({ error: "firstName and lastName are required." });
        }
        if (middleName !== null && !validName(middleName)) {
            return res.status(400).json({ error: "middleName must be a valid name." });
        }
        if (!phoneNumber) {
            return res.status(400).json({ error: "A valid Kenyan mobile number is required." });
        }
        if (!ALLOWED_ROLES.has(role)) {
            return res.status(400).json({ error: "role must be CONSUMER or READER." });
        }
        if (accountNumber !== null && (
            typeof accountNumber !== "string"
            || accountNumber.trim().length === 0
            || accountNumber.trim().length > 100
        )) {
            return res.status(400).json({ error: "accountNumber must be a non-empty string." });
        }
        if (location !== null && (typeof location !== "string" || location.trim().length > 200)) {
            return res.status(400).json({ error: "location must be a string no longer than 200 characters." });
        }

        try {
            const user = await prismaClient.user.create({
                data: {
                    firstName: firstName.trim(),
                    middleName: middleName?.trim() ?? null,
                    lastName: lastName.trim(),
                    phoneNumber,
                    passwordHash: await hashPassword(phoneNumber),
                    role,
                    accountNumber: accountNumber?.trim() || null,
                    location: location?.trim() || null,
                },
            });
            return res.status(201).json({
                message: "User created. Their initial password is their normalized phone number.",
                user: publicUser(user),
            });
        } catch (error) {
            if (error?.code === "P2002") {
                return res.status(409).json({
                    error: "A user with that phone number or account number already exists.",
                });
            }
            console.error("Admin user creation failed:", error);
            return res.status(500).json({ error: "Unable to create user account." });
        }
    };
}

export function createAdminPasswordResetHandler(prismaClient = prisma) {
    return async function resetUserPassword(req, res) {
        const { id } = req.params;
        if (!id || typeof id !== "string") {
            return res.status(400).json({ error: "A user ID is required." });
        }

        try {
            const user = await prismaClient.user.findUnique({ where: { id } });
            if (!user) {
                return res.status(404).json({ error: "User account was not found." });
            }
            if (!user.phoneNumber) {
                return res.status(409).json({
                    error: "Cannot reset to a phone-number password because this account has no phone number.",
                });
            }

            await prismaClient.user.update({
                where: { id },
                data: { passwordHash: await hashPassword(user.phoneNumber) },
            });
            return res.status(200).json({
                message: "Password reset. The temporary password is the user's normalized phone number.",
            });
        } catch (error) {
            console.error("Admin password reset failed:", error);
            return res.status(500).json({ error: "Unable to reset user password." });
        }
    };
}

export function createAdminPhoneUpdateHandler(prismaClient = prisma) {
    return async function updateUserPhone(req, res) {
        const { id } = req.params;
        const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
        if (!id) {
            return res.status(400).json({ error: "A user ID is required." });
        }
        if (!phoneNumber) {
            return res.status(400).json({ error: "A valid Kenyan mobile number is required." });
        }

        try {
            const user = await prismaClient.user.findUnique({ where: { id } });
            if (!user) {
                return res.status(404).json({ error: "User account was not found." });
            }
            await prismaClient.user.update({
                where: { id },
                data: {
                    phoneNumber,
                    passwordHash: await hashPassword(phoneNumber),
                },
            });
            return res.status(200).json({
                message: "Phone number updated and password reset to the new normalized phone number.",
            });
        } catch (error) {
            if (error?.code === "P2002") {
                return res.status(409).json({ error: "That phone number is already assigned to another user." });
            }
            console.error("Admin phone update failed:", error);
            return res.status(500).json({ error: "Unable to update the user's phone number." });
        }
    };
}

export function createAdminPhoneDeleteHandler(prismaClient = prisma) {
    return async function removeUserPhone(req, res) {
        if (req.user?.role !== "ADMIN") {
            return res.status(403).json({ error: "Only administrators can remove user phone numbers." });
        }

        const { id } = req.params;
        if (typeof id !== "string" || id.trim() === "") {
            return res.status(400).json({ error: "A user ID is required." });
        }

        try {
            const user = await prismaClient.user.findUnique({
                where: { id },
                select: { id: true, phoneNumber: true },
            });
            if (!user) {
                return res.status(404).json({ error: "User account was not found." });
            }
            if (!user.phoneNumber) {
                return res.status(409).json({ error: "This account does not have a phone number to remove." });
            }

            return res.status(409).json({
                error: "Phone number cannot be removed because it is currently required for sign-in. Configure an alternate sign-in method first.",
            });
        } catch (error) {
            console.error("Admin phone removal check failed:", error);
            return res.status(500).json({ error: "Unable to remove the user's phone number." });
        }
    };
}

export function createAdminUserDeleteHandler(prismaClient = prisma) {
    return async function deleteAdminManagedUser(req, res) {
        if (req.user?.role !== "ADMIN") {
            return res.status(403).json({ error: "Only administrators can delete user accounts." });
        }

        const { id } = req.params;
        if (typeof id !== "string" || id.trim() === "") {
            return res.status(400).json({ error: "A user ID is required." });
        }

        try {
            const result = await prismaClient.$transaction(async (tx) => {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "User"
                    WHERE "id" = ${id}
                    FOR UPDATE
                `;

                const user = await tx.user.findUnique({
                    where: { id },
                    select: { id: true },
                });
                if (!user) return { notFound: true };

                const linkedReadings = await tx.meterReading.count({
                    where: {
                        OR: [
                            { customerId: id },
                            { readerId: id },
                        ],
                    },
                });
                if (linkedReadings > 0) return { hasHistory: true };

                await tx.user.delete({ where: { id } });
                return { deleted: true };
            });

            if (result.notFound) {
                return res.status(404).json({ error: "User account was not found." });
            }
            if (result.hasHistory) {
                return res.status(409).json({
                    error: "This account has linked meter-reading or billing history and cannot be deleted.",
                });
            }
            return res.status(200).json({ message: "User account deleted successfully." });
        } catch (error) {
            if (error?.code === "P2003" || error?.code === "P2014") {
                return res.status(409).json({
                    error: "This account has linked records and cannot be deleted.",
                });
            }
            console.error("Admin user deletion failed:", error);
            return res.status(500).json({ error: "Unable to delete user account." });
        }
    };
}

export const createAdminUser = createAdminUserHandler();
export const resetUserPassword = createAdminPasswordResetHandler();
export const updateUserPhone = createAdminPhoneUpdateHandler();
export const removeUserPhone = createAdminPhoneDeleteHandler();
export const deleteAdminManagedUser = createAdminUserDeleteHandler();
