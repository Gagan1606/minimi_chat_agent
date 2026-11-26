import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openApiDocument } from "./openapi.js";

const destination = resolve(process.cwd(), "docs/api/openapi.json");
await writeFile(destination, `${JSON.stringify(openApiDocument, null, 2)}\n`);
process.stdout.write(`Wrote ${destination}\n`);
