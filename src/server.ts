import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

function sendJson(
  response: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export function createAppServer(): Server {
  return createServer((request, response) => {
    if (request.url === "/health/live") {
      if (request.method !== "GET") {
        sendJson(response, 405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
        });
        return;
      }

      sendJson(response, 200, { status: "ok" });
      return;
    }

    sendJson(response, 404, {
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });
}
