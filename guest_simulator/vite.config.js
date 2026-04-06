import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const STORAGE_ROUTE = "/api/storage/results";
const STORAGE_FILE = "data/eval_results_store.json";

function createEmptyPayload() {
  return {
    updatedAt: null,
    batchRange: { start: 1, end: 10 },
    summary: {
      totalSessions: 0,
      sessionsWithoutErrors: 0,
      nsr: "0.00%",
      confirmedBookings: 0,
      cr: "0.00%",
      avgResponseTimeMs: 0,
    },
    sessions: [],
  };
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) {
    return { ...createEmptyPayload(), sessions: payload };
  }

  if (!payload || typeof payload !== "object") {
    return createEmptyPayload();
  }

  return {
    ...createEmptyPayload(),
    ...payload,
    batchRange: {
      ...createEmptyPayload().batchRange,
      ...(payload.batchRange || {}),
    },
    summary: {
      ...createEmptyPayload().summary,
      ...(payload.summary || {}),
    },
    sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
  };
}

function createResultsStoragePlugin() {
  const projectRoot = fileURLToPath(new URL(".", import.meta.url));
  const storagePath = path.join(projectRoot, STORAGE_FILE);

  const readStorage = async () => {
    await mkdir(path.dirname(storagePath), { recursive: true });

    try {
      const raw = await readFile(storagePath, "utf8");
      return normalizePayload(JSON.parse(raw));
    } catch (error) {
      const payload = createEmptyPayload();
      await writeFile(storagePath, JSON.stringify(payload, null, 2), "utf8");
      return payload;
    }
  };

  const writeStorage = async payload => {
    const normalized = normalizePayload(payload);
    await mkdir(path.dirname(storagePath), { recursive: true });
    await writeFile(storagePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  };

  const readJsonBody = async request => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  };

  const sendJson = (response, statusCode, payload) => {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  };

  const attachMiddleware = server => {
    server.middlewares.use((request, response, next) => {
      const pathname = request.url ? request.url.split("?")[0] : "";
      if (pathname !== STORAGE_ROUTE) {
        next();
        return;
      }

      void (async () => {
        try {
          if (request.method === "GET") {
            const payload = await readStorage();
            sendJson(response, 200, { file: STORAGE_FILE, ...payload });
            return;
          }

          if (request.method === "POST") {
            const body = await readJsonBody(request);
            const payload = await writeStorage(body);
            sendJson(response, 200, { ok: true, file: STORAGE_FILE, ...payload });
            return;
          }

          sendJson(response, 405, { error: "Method not allowed" });
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : "Storage error" });
        }
      })();
    });
  };

  return {
    name: "results-storage",
    configureServer: attachMiddleware,
    configurePreviewServer: attachMiddleware,
  };
}

export default defineConfig({
  plugins: [react(), createResultsStoragePlugin()],
});
