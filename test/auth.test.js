import assert from "node:assert/strict";
import test from "node:test";
import {
    createChangePasswordHandler,
    createLoginHandler,
} from "../src/controllers/authController.js";
import {
    createAdminPasswordResetHandler,
    createAdminPhoneDeleteHandler,
    createAdminPhoneUpdateHandler,
    createAdminUserHandler,
    createAdminUserDeleteHandler,
} from "../src/controllers/adminUserController.js";
import { comparePasswords, verifyToken } from "../src/utils/auth.js";
import {
    createAuthenticateJWT,
    requirePasswordChangeComplete,
} from "../src/middleware/authGuard.js";
import { bootstrapAdmin } from "../src/utils/bootstrapAdmin.js";

const USER = {
    id: "consumer-1",
    accountNumber: "WTR-001",
    firstName: "Amina",
    middleName: null,
    lastName: "Wanjiku",
    phoneNumber: "254712345678",
    passwordHash: null,
    role: "CONSUMER",
    location: "Village",
};

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

test("first login initializes imported accounts and returns a restricted token", async () => {
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-auth-tests";
    const state = { user: structuredClone(USER) };
    const prisma = {
        user: {
            async findUnique() {
                return state.user;
            },
            async update({ data }) {
                Object.assign(state.user, data);
                return state.user;
            },
        },
    };

    try {
        const res = response();
        await createLoginHandler(prisma)(
            { body: { phoneNumber: "0712345678", password: USER.phoneNumber } },
            res,
        );

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.mustChangePassword, true);
        assert.equal(verifyToken(res.body.token).mustChangePassword, true);
        assert.equal(await comparePasswords(USER.phoneNumber, state.user.passwordHash), true);
        assert.equal("passwordHash" in res.body.user, false);
    } finally {
        if (oldSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = oldSecret;
    }
});

test("login rejects an incorrect password without updating the account", async () => {
    let updateCalled = false;
    const prisma = {
        user: {
            async findUnique() {
                return structuredClone(USER);
            },
            async update() {
                updateCalled = true;
            },
        },
    };
    const res = response();

    await createLoginHandler(prisma)(
        { body: { phoneNumber: USER.phoneNumber, password: "not-the-phone" } },
        res,
    );

    assert.equal(res.statusCode, 401);
    assert.equal(updateCalled, false);
});

test("password change stores a hash and rejects the phone number as a new password", async () => {
    let storedHash = null;
    const prisma = {
        user: {
            async findUnique() {
                return { ...USER, passwordHash: storedHash };
            },
            async update({ data }) {
                storedHash = data.passwordHash;
            },
        },
    };
    const handler = createChangePasswordHandler(prisma);
    const forcedPasswordRes = response();
    await handler(
        {
            user: { id: USER.id },
            body: {
                currentPassword: USER.phoneNumber,
                newPassword: USER.phoneNumber,
            },
        },
        forcedPasswordRes,
    );
    assert.equal(forcedPasswordRes.statusCode, 400);
    assert.equal(storedHash, null);

    const res = response();
    await handler(
        {
            user: { id: USER.id },
            body: {
                currentPassword: USER.phoneNumber,
                newPassword: "secure-new-password-2026",
            },
        },
        res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(await comparePasswords("secure-new-password-2026", storedHash), true);
});

test("admin can create reader accounts but cannot create another admin through this endpoint", async () => {
    let createdData;
    const prisma = {
        user: {
            async create({ data }) {
                createdData = data;
                return { id: "reader-1", ...data };
            },
        },
    };
    const handler = createAdminUserHandler(prisma);
    const forbidden = response();
    await handler(
        {
            body: {
                firstName: "Reader",
                lastName: "One",
                phoneNumber: "0712345678",
                role: "ADMIN",
            },
        },
        forbidden,
    );
    assert.equal(forbidden.statusCode, 400);
    assert.equal(createdData, undefined);

    const created = response();
    await handler(
        {
            body: {
                firstName: "Reader",
                lastName: "One",
                phoneNumber: "0712345678",
                role: "READER",
            },
        },
        created,
    );
    assert.equal(created.statusCode, 201);
    assert.equal(createdData.phoneNumber, USER.phoneNumber);
    assert.equal(await comparePasswords(USER.phoneNumber, createdData.passwordHash), true);
    assert.equal("passwordHash" in created.body.user, false);
});

test("admin password reset returns account phone as its temporary password", async () => {
    let updated;
    const prisma = {
        user: {
            async findUnique() {
                return structuredClone(USER);
            },
            async update({ data }) {
                updated = data;
            },
        },
    };
    const res = response();
    await createAdminPasswordResetHandler(prisma)(
        { params: { id: USER.id } },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(await comparePasswords(USER.phoneNumber, updated.passwordHash), true);
});

test("admin phone correction updates the phone and resets the temporary password", async () => {
    let updated;
    const prisma = {
        user: {
            async findUnique() {
                return { ...structuredClone(USER), phoneNumber: null };
            },
            async update({ data }) {
                updated = data;
            },
        },
    };
    const res = response();
    await createAdminPhoneUpdateHandler(prisma)(
        {
            params: { id: USER.id },
            body: { phoneNumber: "0711222333" },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(updated.phoneNumber, "254711222333");
    assert.equal(await comparePasswords(updated.phoneNumber, updated.passwordHash), true);
});

test("phone removal rejects non-admin requesters", async () => {
    let lookupCalled = false;
    const handler = createAdminPhoneDeleteHandler({
        user: {
            async findUnique() {
                lookupCalled = true;
            },
        },
    });
    const res = response();

    await handler({ params: { id: USER.id }, user: { role: "READER" } }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(lookupCalled, false);
});

test("phone removal returns not found for an unknown user", async () => {
    const handler = createAdminPhoneDeleteHandler({
        user: {
            async findUnique() {
                return null;
            },
        },
    });
    const res = response();

    await handler({ params: { id: "missing-user" }, user: { role: "ADMIN" } }, res);

    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not found/i);
});

test("phone removal is blocked while phone number is required for sign-in", async () => {
    let updateCalled = false;
    const handler = createAdminPhoneDeleteHandler({
        user: {
            async findUnique() {
                return { id: USER.id, phoneNumber: USER.phoneNumber };
            },
            async update() {
                updateCalled = true;
            },
        },
    });
    const res = response();

    await handler({ params: { id: USER.id }, user: { role: "ADMIN" } }, res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /required for sign-in/i);
    assert.equal(updateCalled, false);
});

test("user deletion rejects non-admin requesters", async () => {
    let transactionCalled = false;
    const handler = createAdminUserDeleteHandler({
        async $transaction() {
            transactionCalled = true;
        },
    });
    const res = response();

    await handler({ params: { id: USER.id }, user: { role: "READER" } }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(transactionCalled, false);
});

test("user deletion returns not found for a missing account", async () => {
    const prisma = {
        async $transaction(work) {
            return work({
                async $queryRaw() {},
                user: {
                    async findUnique() { return null; },
                },
            });
        },
    };
    const res = response();

    await createAdminUserDeleteHandler(prisma)(
        { params: { id: "missing-user" }, user: { role: "ADMIN" } },
        res,
    );

    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not found/i);
});

test("admin can delete an account with no linked reading history", async () => {
    let deletedId;
    const prisma = {
        async $transaction(work) {
            return work({
                async $queryRaw() {},
                user: {
                    async findUnique() { return { id: USER.id }; },
                    async delete({ where }) { deletedId = where.id; },
                },
                meterReading: {
                    async count() { return 0; },
                },
            });
        },
    };
    const res = response();

    await createAdminUserDeleteHandler(prisma)(
        { params: { id: USER.id }, user: { role: "ADMIN" } },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(deletedId, USER.id);
    assert.match(res.body.message, /deleted successfully/i);
});

test("admin cannot delete an account linked to meter reading or billing history", async () => {
    let deleteCalled = false;
    const prisma = {
        async $transaction(work) {
            return work({
                async $queryRaw() {},
                user: {
                    async findUnique() { return { id: USER.id }; },
                    async delete() { deleteCalled = true; },
                },
                meterReading: {
                    async count() { return 1; },
                },
            });
        },
    };
    const res = response();

    await createAdminUserDeleteHandler(prisma)(
        { params: { id: USER.id }, user: { role: "ADMIN" } },
        res,
    );

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /linked meter-reading or billing history/i);
    assert.equal(deleteCalled, false);
});

test("temporary-password tokens are blocked from protected app routes", () => {
    const res = response();
    let nextCalled = false;
    requirePasswordChangeComplete(
        { user: { mustChangePassword: true } },
        res,
        () => {
            nextCalled = true;
        },
    );

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test("authentication fails closed when token revocation cannot be checked", async () => {
    const res = response();
    let verifyCalled = false;
    const originalError = console.error;
    console.error = () => {};
    try {
        await createAuthenticateJWT({
            async checkTokenRevoked() {
                throw new Error("database unavailable");
            },
            verify() {
                verifyCalled = true;
                return {};
            },
        })({ headers: { authorization: "Bearer valid-token" } }, res, () => {});
    } finally {
        console.error = originalError;
    }

    assert.equal(res.statusCode, 503);
    assert.equal(verifyCalled, false);
});

test("admin bootstrap requires a strong password and refuses existing admins", async () => {
    const baseConfig = {
        BOOTSTRAP_ADMIN_FIRST_NAME: "First",
        BOOTSTRAP_ADMIN_LAST_NAME: "Admin",
        BOOTSTRAP_ADMIN_PHONE: "0712345678",
        BOOTSTRAP_ADMIN_PASSWORD: "bootstrap-password-2026",
    };
    let created;
    const emptyDatabase = {
        user: {
            async findFirst() {
                return null;
            },
            async create({ data, select }) {
                created = data;
                return Object.fromEntries(Object.keys(select).map((key) => [key, data[key] ?? "new-id"]));
            },
        },
    };
    const result = await bootstrapAdmin(emptyDatabase, baseConfig);
    assert.equal(result.role, "ADMIN");
    assert.equal(created.phoneNumber, USER.phoneNumber);
    assert.equal(await comparePasswords(baseConfig.BOOTSTRAP_ADMIN_PASSWORD, created.passwordHash), true);

    await assert.rejects(
        bootstrapAdmin(emptyDatabase, {
            ...baseConfig,
            BOOTSTRAP_ADMIN_PASSWORD: USER.phoneNumber,
        }),
        /unique password/,
    );
    await assert.rejects(
        bootstrapAdmin({
            user: {
                async findFirst() {
                    return { id: "existing-admin" };
                },
            },
        }, baseConfig),
        /admin account already exists/,
    );
});
