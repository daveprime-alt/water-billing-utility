import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
    CustomerImportInputError,
    normalizeCustomerNameKey,
    parseCustomerWorkbook,
} from "../utils/customerImport.js";

const prisma = new PrismaClient();

function generateAccountNumber(location) {
    const villagePrefix = String(location ?? "")
        .normalize("NFKD")
        .replace(/[^a-z]/gi, "")
        .slice(0, 3)
        .toUpperCase() || "GEN";
    return `WTR-${villagePrefix}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

export function createImportCustomersHandler(prismaClient = prisma) {
    return async function importCustomers(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: "No spreadsheet file was uploaded." });
    }

    let rows;
    try {
        rows = parseCustomerWorkbook(req.file.buffer);
    } catch (error) {
        if (error instanceof CustomerImportInputError) {
            return res.status(400).json({ error: error.message });
        }
        console.error("Failed to parse customer import workbook:", error);
        return res.status(400).json({ error: "The uploaded spreadsheet could not be parsed." });
    }

    const skippedDetails = [];
    const phoneWarnings = [];
    const candidateRows = [];
    const seenPhoneNumbers = new Set();
    const seenCustomersByName = new Map();

    for (const row of rows) {
        if (row.error) {
            skippedDetails.push({ rowNumber: row.rowNumber, reason: row.error });
            continue;
        }
        if (row.phoneIssue) {
            phoneWarnings.push({ rowNumber: row.rowNumber, reason: row.phoneIssue });
        }
        if (row.phoneNumber && seenPhoneNumbers.has(row.phoneNumber)) {
            skippedDetails.push({
                rowNumber: row.rowNumber,
                reason: "This phone number appears more than once in the spreadsheet.",
            });
            continue;
        }
        if (row.phoneNumber) seenPhoneNumbers.add(row.phoneNumber);
        const nameKey = normalizeCustomerNameKey(row);
        const sameNameRows = seenCustomersByName.get(nameKey) ?? [];
        const duplicateInSpreadsheet = sameNameRows.some((existing) =>
            !row.phoneNumber
            || !existing.phoneNumber
            || row.phoneNumber === existing.phoneNumber);
        if (duplicateInSpreadsheet) {
            skippedDetails.push({
                rowNumber: row.rowNumber,
                reason: "A customer with the same name and phone number (or the same name when no phone number is available) appears more than once in the spreadsheet.",
            });
            continue;
        }
        sameNameRows.push(row);
        seenCustomersByName.set(nameKey, sameNameRows);
        candidateRows.push(row);
    }

    try {
        const phoneNumbers = candidateRows
            .map((row) => row.phoneNumber)
            .filter(Boolean);
        const nameMatchers = candidateRows.map((row) => {
            const tokens = [
                ...row.firstName.normalize("NFKC").trim().split(/\s+/),
                ...row.lastName.normalize("NFKC").trim().split(/\s+/),
            ].filter(Boolean);
            return {
                AND: tokens.map((token) => ({
                    OR: [
                        { firstName: { contains: token, mode: "insensitive" } },
                        { middleName: { contains: token, mode: "insensitive" } },
                        { lastName: { contains: token, mode: "insensitive" } },
                    ],
                })),
            };
        });
        const existingUsers = [];
        for (let index = 0; index < nameMatchers.length; index += 100) {
            existingUsers.push(...await prismaClient.user.findMany({
                where: { OR: nameMatchers.slice(index, index + 100) },
                select: {
                    firstName: true,
                    middleName: true,
                    lastName: true,
                    phoneNumber: true,
                },
            }));
        }
        const existingPhones = phoneNumbers.length > 0
            ? await prismaClient.user.findMany({
                where: { phoneNumber: { in: phoneNumbers } },
                select: { phoneNumber: true },
            })
            : [];
        const existingPhoneNumbers = new Set(existingPhones.map((user) => user.phoneNumber));
        const existingCustomersByName = new Map();
        for (const user of existingUsers) {
            const nameKey = normalizeCustomerNameKey(user);
            const customers = existingCustomersByName.get(nameKey) ?? [];
            customers.push(user);
            existingCustomersByName.set(nameKey, customers);
        }

        const createRows = [];
        for (const row of candidateRows) {
            if (row.phoneNumber && existingPhoneNumbers.has(row.phoneNumber)) {
                skippedDetails.push({
                    rowNumber: row.rowNumber,
                    reason: "A customer with this phone number already exists.",
                });
                continue;
            }
            const nameKey = normalizeCustomerNameKey(row);
            const matchingName = existingCustomersByName.get(nameKey) ?? [];
            const duplicateByName = matchingName.some((user) =>
                !row.phoneNumber
                || !user.phoneNumber
                || user.phoneNumber === row.phoneNumber);
            if (duplicateByName) {
                skippedDetails.push({
                    rowNumber: row.rowNumber,
                    reason: row.phoneNumber
                        ? "A customer with this name and phone number already exists."
                        : "A customer with this name already exists and the imported row has no valid phone number.",
                });
                continue;
            }
            createRows.push({
                accountNumber: generateAccountNumber(row.location),
                firstName: row.firstName,
                middleName: row.middleName,
                lastName: row.lastName,
                phoneNumber: row.phoneNumber,
                passwordHash: null,
                role: "CONSUMER",
                location: row.location,
            });
        }

        const result = createRows.length > 0
            ? await prismaClient.user.createMany({ data: createRows, skipDuplicates: true })
            : { count: 0 };
        const databaseConflictCount = createRows.length - result.count;
        const recordsSkipped = rows.length - result.count;

        return res.status(200).json({
            message: "Customer import completed.",
            recordsProcessed: rows.length,
            recordsImported: result.count,
            recordsSkipped,
            recordsWithMissingOrInvalidPhone: phoneWarnings.length,
            phoneWarnings,
            skippedDetails,
            databaseConflictCount,
        });
    } catch (error) {
        console.error("Customer import database operation failed:", error);
        return res.status(500).json({ error: "Customer import failed while saving records." });
    }
    };
}

export const importCustomers = createImportCustomersHandler();
