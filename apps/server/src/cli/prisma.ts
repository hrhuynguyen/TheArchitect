import { runPrismaCommand } from "../db/prisma-command.js";

process.exitCode = await runPrismaCommand(process.argv.slice(2));
