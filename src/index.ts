import "dotenv/config";
import { createAppServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Startup failed: PORT must be an integer from 1 to 65535.");
  process.exit(1);
}

const server = createAppServer();
server.once("error", () => {
  console.error("Startup failed: could not bind the configured host and port.");
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Momos listening at http://${host}:${port}`);
});
