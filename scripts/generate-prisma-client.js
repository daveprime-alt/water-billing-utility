import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const prismaCli = resolve(projectRoot, "node_modules/prisma6/build/index.js");
const schemaPath = resolve(projectRoot, "prisma/schema.prisma");

const result = spawnSync(
    process.execPath,
    [prismaCli, "generate", "--schema", schemaPath],
    { cwd: tmpdir(), stdio: "inherit" },
);

if (result.error) {
    throw result.error;
}

if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
}
