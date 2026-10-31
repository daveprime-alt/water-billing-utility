import * as xlsx from "xlsx";
import { normalizePhoneNumber } from "./phoneSanitizer.js";

export const MAX_CUSTOMER_IMPORT_ROWS = 5000;

export class CustomerImportInputError extends Error {}

const normalizeHeader = (header) => String(header ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const findColumn = (headers, aliases) => headers.findIndex((header) => aliases.includes(header));
const cellText = (value) => value === null || value === undefined ? "" : String(value).trim();
const isBlankRow = (row) => row.every((cell) => cellText(cell) === "");

export function normalizeCustomerNameKey(customer) {
    return [customer.firstName, customer.middleName, customer.lastName]
        .map((part) => String(part ?? "")
            .normalize("NFKC")
            .trim()
            .replace(/\s+/g, " ")
            .toLocaleLowerCase("en"))
        .join(" ");
}

function splitName(value) {
    const parts = cellText(value).split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
        return { firstName: parts[0], middleName: null, lastName: "" };
    }
    return {
        firstName: parts[0],
        middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : null,
        lastName: parts[parts.length - 1],
    };
}

export function parseCustomerWorkbook(buffer) {
    let workbook;
    try {
        workbook = xlsx.read(buffer, { type: "buffer", cellDates: true });
    } catch {
        throw new CustomerImportInputError("The uploaded file could not be read as an Excel workbook.");
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        throw new CustomerImportInputError("The workbook does not contain a worksheet.");
    }

    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        raw: false,
        defval: "",
        blankrows: true,
    });
    const headerRowIndex = rows.findIndex((row) => !isBlankRow(row));
    if (headerRowIndex < 0) {
        throw new CustomerImportInputError("The worksheet is empty.");
    }
    if (rows.length - headerRowIndex - 1 > MAX_CUSTOMER_IMPORT_ROWS) {
        throw new CustomerImportInputError(
            `The worksheet may contain at most ${MAX_CUSTOMER_IMPORT_ROWS} customer rows.`,
        );
    }

    const headers = rows[headerRowIndex].map(normalizeHeader);
    const fullNameColumn = findColumn(headers, [
        "customer name",
        "customer full name",
        "consumer name",
        "full name",
        "name",
    ]);
    const firstNameColumn = findColumn(headers, ["first name", "firstname", "given name"]);
    const middleNameColumn = findColumn(headers, ["middle name", "middlename"]);
    const lastNameColumn = findColumn(headers, ["last name", "lastname", "surname", "family name"]);
    const phoneColumn = findColumn(headers, [
        "phone number",
        "telephone number",
        "mobile number",
        "contact number",
        "telephone",
        "phone",
        "mobile",
        "contact",
    ]);
    const locationColumn = findColumn(headers, [
        "village",
        "zone",
        "location",
        "estate",
        "area",
    ]);

    if (fullNameColumn < 0 && firstNameColumn < 0) {
        throw new CustomerImportInputError(
            "The worksheet must include a customer name column or a first name column.",
        );
    }

    const customers = [];
    for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
        const row = rows[index];
        if (isBlankRow(row)) continue;

        let name;
        if (fullNameColumn >= 0 && cellText(row[fullNameColumn]) !== "") {
            name = splitName(row[fullNameColumn]);
        } else if (firstNameColumn >= 0) {
            const firstName = cellText(row[firstNameColumn]);
            const middleName = middleNameColumn >= 0 ? cellText(row[middleNameColumn]) : "";
            const lastName = lastNameColumn >= 0 ? cellText(row[lastNameColumn]) : "";
            name = firstName
                ? { firstName, middleName: middleName || null, lastName }
                : null;
        } else {
            name = null;
        }

        if (!name) {
            customers.push({
                rowNumber: index + 1,
                error: "Customer name is missing.",
            });
            continue;
        }

        const rawPhone = phoneColumn >= 0 ? row[phoneColumn] : "";
        const phoneText = cellText(rawPhone);
        const phoneNumber = normalizePhoneNumber(rawPhone);
        const location = locationColumn >= 0 ? cellText(row[locationColumn]) : "";

        customers.push({
            rowNumber: index + 1,
            ...name,
            location: location || null,
            phoneNumber,
            phoneIssue: phoneText && !phoneNumber
                ? "Phone number is invalid; customer will be imported without a phone number."
                : phoneNumber
                    ? null
                    : "Phone number is missing; customer will be imported without a phone number.",
        });
    }

    return customers;
}
