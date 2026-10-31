import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { bootstrapAdmin } from "../src/utils/bootstrapAdmin.js";

dotenv.config();

const prisma = new PrismaClient();

try {
    const admin = await bootstrapAdmin(prisma, process.env);
    console.log(`Bootstrap admin created for ${admin.phoneNumber}.`);
} catch (error) {
    console.error("Admin bootstrap failed:", error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
