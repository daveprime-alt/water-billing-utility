import assert from "node:assert/strict";
import test from "node:test";
import { createUserDirectoryHandler } from "../src/controllers/userController.js";

function createResponse() {
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

function createPrisma({ users = [], total = users.length } = {}) {
    const calls = [];
    return {
        calls,
        user: {
            async findMany(query) {
                calls.push({ operation: "findMany", query });
                return users;
            },
            async count(query) {
                calls.push({ operation: "count", query });
                return total;
            },
        },
    };
}

test("admin can search all roles with bounded pagination and safe selected fields", async () => {
    const prisma = createPrisma({ total: 25 });
    const res = createResponse();

    await createUserDirectoryHandler(prisma)(
        {
            user: { role: "ADMIN" },
            query: { search: "Amina Wanjiku", page: "2", pageSize: "10" },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.pagination, {
        page: 2,
        pageSize: 10,
        total: 25,
        totalPages: 3,
    });
    const query = prisma.calls.find((call) => call.operation === "findMany").query;
    assert.equal(query.skip, 10);
    assert.equal(query.take, 10);
    assert.equal(query.where.role, undefined);
    assert.deepEqual(query.select, {
        id: true,
        accountNumber: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phoneNumber: true,
        role: true,
        location: true,
        createdAt: true,
    });
    assert.equal(query.where.AND.length, 2);
    assert.deepEqual(
        prisma.calls.find((call) => call.operation === "count").query.where,
        query.where,
    );
});

test("reader search is always restricted to consumers and supports normalized phone search", async () => {
    const prisma = createPrisma();
    const res = createResponse();

    await createUserDirectoryHandler(prisma)(
        {
            user: { role: "READER" },
            query: { search: "0712345678" },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    const query = prisma.calls.find((call) => call.operation === "findMany").query;
    assert.equal(query.where.role, "CONSUMER");
    assert.deepEqual(query.where.AND[0].OR.at(-1), {
        phoneNumber: { contains: "254712345678", mode: "insensitive" },
    });
});

test("admin can filter by role", async () => {
    const prisma = createPrisma();
    const res = createResponse();

    await createUserDirectoryHandler(prisma)(
        { user: { role: "ADMIN" }, query: { role: "READER" } },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls[0].query.where.role, "READER");
});

test("reader cannot request a non-consumer directory role", async () => {
    const prisma = createPrisma();
    const res = createResponse();

    await createUserDirectoryHandler(prisma)(
        { user: { role: "READER" }, query: { role: "ADMIN" } },
        res,
    );

    assert.equal(res.statusCode, 403);
    assert.equal(prisma.calls.length, 0);
});

test("invalid pagination, role, and overlong search are rejected", async () => {
    for (const query of [
        { page: "0" },
        { pageSize: "101" },
        { role: "UNKNOWN" },
        { search: "x".repeat(101) },
    ]) {
        const prisma = createPrisma();
        const res = createResponse();
        await createUserDirectoryHandler(prisma)(
            { user: { role: "ADMIN" }, query },
            res,
        );
        assert.equal(res.statusCode, 400);
        assert.equal(prisma.calls.length, 0);
    }
});
