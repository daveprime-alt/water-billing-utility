import { hashPassword } from "./auth.js";
import { normalizePhoneNumber } from "./phoneSanitizer.js";

export async function bootstrapAdmin(prisma, configuration) {
    const firstName = configuration.BOOTSTRAP_ADMIN_FIRST_NAME?.trim();
    const lastName = configuration.BOOTSTRAP_ADMIN_LAST_NAME?.trim();
    const phoneNumber = normalizePhoneNumber(configuration.BOOTSTRAP_ADMIN_PHONE);
    const password = configuration.BOOTSTRAP_ADMIN_PASSWORD;

    if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
        throw new Error("Set BOOTSTRAP_ADMIN_FIRST_NAME and BOOTSTRAP_ADMIN_LAST_NAME (1-100 characters).");
    }
    if (!phoneNumber) {
        throw new Error("Set BOOTSTRAP_ADMIN_PHONE to a valid Kenyan mobile number.");
    }
    if (
        typeof password !== "string"
        || password.length < 12
        || Buffer.byteLength(password, "utf8") > 72
        || password === phoneNumber
    ) {
        throw new Error("Set BOOTSTRAP_ADMIN_PASSWORD to a unique password of at least 12 characters and no more than 72 UTF-8 bytes.");
    }

    const existingAdmin = await prisma.user.findFirst({
        where: { role: "ADMIN" },
        select: { id: true },
    });
    if (existingAdmin) {
        throw new Error("An admin account already exists; bootstrap was refused.");
    }

    return prisma.user.create({
        data: {
            firstName,
            lastName,
            phoneNumber,
            passwordHash: await hashPassword(password),
            role: "ADMIN",
        },
        select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            role: true,
        },
    });
}
