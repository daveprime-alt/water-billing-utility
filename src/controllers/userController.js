import { PrismaClient } from "@prisma/client";
import { normalizePhoneNumber } from "../utils/phoneSanitizer.js";

const prisma = new PrismaClient();
const DIRECTORY_ROLES = new Set(["ADMIN", "READER", "CONSUMER"]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

function parsePositiveInteger(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function buildDirectorySearch(search) {
    if (!search) return undefined;

    const tokens = search.split(/\s+/).filter(Boolean);
    const normalizedPhone = normalizePhoneNumber(search);
    const phoneSearches = new Set([search]);
    if (normalizedPhone) phoneSearches.add(normalizedPhone);

    return {
        AND: tokens.map((token) => ({
            OR: [
                { firstName: { contains: token, mode: "insensitive" } },
                { middleName: { contains: token, mode: "insensitive" } },
                { lastName: { contains: token, mode: "insensitive" } },
                { accountNumber: { contains: token, mode: "insensitive" } },
                ...[...phoneSearches].map((phone) => ({
                    phoneNumber: { contains: phone, mode: "insensitive" },
                })),
            ],
        })),
    };
}

export function createUserDirectoryHandler(prismaClient = prisma) {
    return async function getUserDirectory(req, res) {
        const page = parsePositiveInteger(req.query.page, 1);
        const pageSize = parsePositiveInteger(req.query.pageSize, DEFAULT_PAGE_SIZE);
        if (page === null || pageSize === null || pageSize > MAX_PAGE_SIZE) {
            return res.status(400).json({
                error: `page must be a positive integer and pageSize must be between 1 and ${MAX_PAGE_SIZE}.`,
            });
        }

        const rawSearch = req.query.search;
        if (rawSearch !== undefined && typeof rawSearch !== "string") {
            return res.status(400).json({ error: "search must be a single string." });
        }
        const search = rawSearch?.trim() ?? "";
        if (search.length > MAX_SEARCH_LENGTH) {
            return res.status(400).json({
                error: `search must be no longer than ${MAX_SEARCH_LENGTH} characters.`,
            });
        }

        const requestedRole = req.query.role;
        if (requestedRole !== undefined && (
            typeof requestedRole !== "string" || !DIRECTORY_ROLES.has(requestedRole)
        )) {
            return res.status(400).json({
                error: "role must be ADMIN, READER, or CONSUMER.",
            });
        }
        if (req.user.role === "READER" && requestedRole && requestedRole !== "CONSUMER") {
            return res.status(403).json({ error: "Readers may only search consumers." });
        }

        const where = {
            ...(req.user.role === "READER"
                ? { role: "CONSUMER" }
                : requestedRole
                    ? { role: requestedRole }
                    : {}),
            ...buildDirectorySearch(search),
        };
        const skip = (page - 1) * pageSize;
        if (!Number.isSafeInteger(skip)) {
            return res.status(400).json({ error: "Requested page is too large." });
        }

        try {
            const [users, total] = await Promise.all([
                prismaClient.user.findMany({
                    where,
                    select: {
                        id: true,
                        accountNumber: true,
                        firstName: true,
                        middleName: true,
                        lastName: true,
                        phoneNumber: true,
                        role: true,
                        location: true,
                        createdAt: true,
                    },
                    orderBy: [
                        { lastName: "asc" },
                        { firstName: "asc" },
                        { id: "asc" },
                    ],
                    skip,
                    take: pageSize,
                }),
                prismaClient.user.count({ where }),
            ]);

            return res.status(200).json({
                users,
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: Math.ceil(total / pageSize),
                },
            });
        } catch (error) {
            console.error("Failed to search the user directory:", error);
            return res.status(500).json({ error: "Failed to search the user directory." });
        }
    };
}

export const getUserDirectory = createUserDirectoryHandler();

export async function getUserProfile(req, res) {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
        });

        if (!user) {
            return res.status(404).json({
                error: 'User profile record not found in the database.'
            })
        }

        const { passwordHash, ...sanitizedProfile } = user;
        return res.status(200).json(sanitizedProfile);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({
            error: 'Internal server error.'
        });
    }
};

export const updateUserProfile = async (req, res) => {
    const { firstName, middleName, lastName, location } = req.body;
    try {
        const updateData = {};
        for (const [field, value] of Object.entries({ firstName, middleName, lastName })) {
            if (value !== undefined) {
                if (
                    (field !== "middleName" && value === null)
                    || (value !== null && (
                        typeof value !== "string"
                        || value.trim().length === 0
                        || value.trim().length > 100
                    ))
                ) {
                    return res.status(400).json({ error: `${field} must be a non-empty string.` });
                }
                updateData[field] = value?.trim() ?? null;
            }
        }
        if (location !== undefined) {
            if (location !== null && (
                typeof location !== "string" || location.trim().length > 200
            )) {
                return res.status(400).json({ error: "location must be a string no longer than 200 characters." });
            }
            updateData.location = location?.trim() ?? null;
        }
        const updatedUser = await prisma.user.update({
            where: { id: req.user.id },
            data: updateData,
        });
        
        const { passwordHash, ...sanitizedUpdate } = updatedUser;
        return res.status(200).json({
            message: 'User profile updated successfully.',
            profile: sanitizedUpdate
        });
    } catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({
            error: 'Failed to update personal account records.'
        });
    }
};

export const getUserById = async (req, res) => {
    const { id } = req.params;
    try {
        const user = await prisma.user.findUnique({
            where: { id },
        });

        if (!user) {
            return res.status(404).json({
                error: 'Requested customer record does not exist.'
            })
        }
        const { passwordHash, ...sanitizedUser } = user;
        return res.status(200).json(sanitizedUser);
    } catch (error) {
        console.error('Error in getUserById controller:', error);
        return res.status(500).json({
            error: 'Failed to load details for the requested customer id'
        })
    }
};