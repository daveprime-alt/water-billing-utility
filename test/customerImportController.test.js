import assert from "node:assert/strict";
import test from "node:test";
import * as xlsx from "xlsx";
import { createImportCustomersHandler } from "../src/controllers/customerImportController.js";
import { normalizeCustomerNameKey } from "../src/utils/customerImport.js";

function makeWorkbook(customers) {
    const sheet = xlsx.utils.aoa_to_sheet([
        ["First Name", "Middle Name", "Last Name", "Phone Number", "Location"],
        ...customers.map((customer) => [
            customer.firstName,
            customer.middleName ?? "",
            customer.lastName,
            customer.phoneNumber ?? "",
            customer.location ?? "",
        ]),
    ]);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, sheet, "Customers");
    return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function createPrisma(initialUsers = []) {
    const users = structuredClone(initialUsers);
    return {
        users,
        user: {
            async findMany({ where }) {
                if (where.OR) {
                    return users.filter((user) => where.OR.some((matcher) =>
                        matcher.AND.every(({ OR }) => OR.some((fieldMatcher) => {
                            const [field, condition] = Object.entries(fieldMatcher)[0];
                            return String(user[field] ?? "")
                                .toLocaleLowerCase("en")
                                .includes(condition.contains.toLocaleLowerCase("en"));
                        }))));
                }
                const phoneNumbers = where.phoneNumber.in;
                return users
                    .filter((user) => phoneNumbers.includes(user.phoneNumber))
                    .map(({ phoneNumber }) => ({ phoneNumber }));
            },
            async createMany({ data }) {
                users.push(...structuredClone(data));
                return { count: data.length };
            },
        },
    };
}

async function importWorkbook(handler, workbook) {
    const res = response();
    await handler({ file: { buffer: workbook } }, res);
    return res;
}

test("reimporting a spreadsheet skips matching phone/name and name-only customers", async () => {
    const prisma = createPrisma();
    const handler = createImportCustomersHandler(prisma);
    const workbook = makeWorkbook([
        {
            firstName: "Amina",
            middleName: "Wanjiku",
            lastName: "Njoroge",
            phoneNumber: "0712345678",
        },
        {
            firstName: "Brian",
            lastName: "Otieno",
        },
    ]);

    const firstImport = await importWorkbook(handler, workbook);
    const secondImport = await importWorkbook(handler, workbook);

    assert.equal(firstImport.statusCode, 200);
    assert.equal(firstImport.body.recordsImported, 2);
    assert.equal(secondImport.statusCode, 200);
    assert.equal(secondImport.body.recordsImported, 0);
    assert.equal(secondImport.body.recordsSkipped, 2);
    assert.equal(prisma.users.length, 2);
});

test("name matching is case-insensitive and ignores repeated whitespace", async () => {
    const prisma = createPrisma([{
        firstName: "  Amina",
        middleName: null,
        lastName: "Wanjiku  ",
        phoneNumber: null,
    }]);
    const handler = createImportCustomersHandler(prisma);
    const workbook = makeWorkbook([{
        firstName: " amina ",
        lastName: "  WANJIKU ",
    }]);

    const result = await importWorkbook(handler, workbook);

    assert.equal(result.body.recordsImported, 0);
    assert.equal(result.body.recordsSkipped, 1);
    assert.match(result.body.skippedDetails[0].reason, /name already exists/i);
});

test("a present phone number matches by both name and normalized phone", async () => {
    const prisma = createPrisma([{
        firstName: "Amina",
        middleName: null,
        lastName: "Wanjiku",
        phoneNumber: "254712345678",
    }]);
    const handler = createImportCustomersHandler(prisma);
    const duplicate = await importWorkbook(handler, makeWorkbook([{
        firstName: "AMINA",
        lastName: "WANJIKU",
        phoneNumber: "+254 712 345 678",
    }]));
    const differentNumber = await importWorkbook(handler, makeWorkbook([{
        firstName: "AMINA",
        lastName: "WANJIKU",
        phoneNumber: "0722345678",
    }]));

    assert.equal(duplicate.body.recordsImported, 0);
    assert.equal(differentNumber.body.recordsImported, 1);
});

test("repeated no-phone names in one spreadsheet are imported once", async () => {
    const prisma = createPrisma();
    const handler = createImportCustomersHandler(prisma);
    const workbook = makeWorkbook([
        { firstName: "Brian", lastName: "Otieno" },
        { firstName: " brian ", lastName: "  OTIENO " },
    ]);

    const result = await importWorkbook(handler, workbook);

    assert.equal(result.body.recordsImported, 1);
    assert.equal(result.body.recordsSkipped, 1);
    assert.equal(prisma.users.length, 1);
});

test("a row without a phone matches the existing customer by name alone", async () => {
    const prisma = createPrisma([{
        firstName: "Amina",
        middleName: null,
        lastName: "Wanjiku",
        phoneNumber: "254712345678",
    }]);
    const handler = createImportCustomersHandler(prisma);

    const result = await importWorkbook(handler, makeWorkbook([{
        firstName: "Amina",
        lastName: "Wanjiku",
    }]));

    assert.equal(result.body.recordsImported, 0);
    assert.equal(result.body.recordsSkipped, 1);
});

test("a name with a different phone remains a distinct match key", async () => {
    const prisma = createPrisma([{
        firstName: "Amina",
        middleName: null,
        lastName: "Wanjiku",
        phoneNumber: "254712345678",
    }]);
    const handler = createImportCustomersHandler(prisma);

    const result = await importWorkbook(handler, makeWorkbook([{
        firstName: "Amina",
        lastName: "Wanjiku",
        phoneNumber: "0722345678",
    }]));

    assert.equal(result.body.recordsImported, 1);
});
