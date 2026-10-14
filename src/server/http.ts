import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { encode, type PushRegisterMsg } from "../protocol.js";
import { ERROR_MESSAGES } from "../core/errors.js";
import type { Hub } from "../core/hub.js";
import { logger } from "../core/log.js";
import { requestToken, tokenMatches } from "./auth.js";
import { DeviceSession } from "./session.js";

const log = logger("server");

export interface DeviceServerOpts {
  hub: Hub;
  token: string;
  port: number;
  host: string;
  onPushRegister?: (m: PushRegisterMsg) => void;
}

export interface DeviceServer {
  server: Server;
  wss: WebSocketServer;
  port: number;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

export async function startDeviceServer(o: DeviceServerOpts): Promise<DeviceServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      if (!tokenMatches(requestToken(req), o.token)) {
        return json(res, 401, { ok: false, error: "unauthorized", message: ERROR_MESSAGES.unauthorized });
      }
      o.hub
        .health()
        .then((h) => json(res, 200, h))
        .catch(() => json(res, 500, { ok: false }));
      return;
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return void res.end("Hikaro connector\n");
    }
    json(res, 404, { ok: false, error: "not_found" });
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const authorized = tokenMatches(requestToken(req), o.token);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      if (!authorized) {
        // Accept, explain in plain Italian, close: the app can show the message.
        ws.send(encode({ type: "error", code: "unauthorized", message: ERROR_MESSAGES.unauthorized }));
        ws.close(4401, "unauthorized");
        log.warn(`rejected unauthorized device from ${req.socket.remoteAddress}`);
        return;
      }
      const alive = { v: true };
      ws.on("pong", () => (alive.v = true));
      const beat = setInterval(() => {
        if (!alive.v) return ws.terminate();
        alive.v = false;
        ws.ping();
      }, 30_000).unref();
      ws.on("close", () => clearInterval(beat));
      const session = new DeviceSession(ws, o.hub, o.onPushRegister);
      log.info(`${session.id} connected from ${req.socket.remoteAddress}`);
      session.open();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    wss,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
