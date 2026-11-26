import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createAppServer } from "../src/server.js";

test("health liveness endpoint reports the process as alive", async () => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/health/live`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("unknown paths return a generic not found response", async () => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
