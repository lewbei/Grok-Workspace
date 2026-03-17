import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import {
  PRICING_CONFIG_VERSION,
  buildPayload,
  buildUsage,
  delay,
  extractOutputText,
  normalizeUpstreamError,
  parseDebugHarness,
  responseTextDelta,
  toolFromEventType,
  toolLabel,
} from "./server-lib.mjs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8787);
const RESPONSES_URL = "https://api.x.ai/v1/responses";

function getApiKey() {
  return process.env.GROK_API_KEY?.trim() || "";
}

function setStreamHeaders(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}

function writeEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

async function handleDebugScenario(res, reqBody, debugScenario) {
  const payload = buildPayload(reqBody);
  const mode = reqBody?.mode === "agent" ? "agent" : "standard";

  if (debugScenario.scenario === "unauthorized") {
    res.status(401).json(normalizeUpstreamError(401, '{"message":"Incorrect API key provided"}'));
    return;
  }

  if (debugScenario.scenario === "forbidden") {
    res
      .status(403)
      .json(
        normalizeUpstreamError(
          403,
          '{"message":"{\"error\":\"Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_BIO\"}"}',
        ),
      );
    return;
  }

  if (debugScenario.scenario === "rate_limit") {
    res.status(429).json(normalizeUpstreamError(429, '{"message":"Too many requests"}'));
    return;
  }

  if (debugScenario.scenario === "upstream_5xx") {
    res.status(503).json(normalizeUpstreamError(503, '{"message":"upstream unavailable"}'));
    return;
  }

  setStreamHeaders(res);

  if (debugScenario.scenario === "malformed_stream") {
    writeEvent(res, { type: "delta", delta: "debug " });
    res.write("not-json\n");
    res.end();
    return;
  }

  if (debugScenario.scenario === "slow_stream") {
    await delay(debugScenario.delayMs);
    writeEvent(res, { type: "delta", delta: "Debug " });
    await delay(debugScenario.delayMs);
    writeEvent(res, { type: "delta", delta: "slow stream complete." });
    writeEvent(res, {
      type: "done",
      message: "Debug slow stream complete.",
      responseId: "debug-slow-stream",
      modelAlias: payload.model,
      usage: buildUsage(mode, { usage: {} }, { web_search: 0, x_search: 0, code_interpreter: 0 }),
    });
    res.end();
    return;
  }

  if (debugScenario.scenario === "dropped_connection") {
    writeEvent(res, { type: "delta", delta: "partial" });
    await delay(40);
    res.socket?.destroy(new Error("debug dropped connection"));
  }
}

export function createApp({ fetchImpl = fetch } = {}) {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      apiKeyConfigured: Boolean(getApiKey()),
      pricingConfigVersion: PRICING_CONFIG_VERSION,
    });
  });

  app.post("/api/chat", async (req, res) => {
    if (!req.body?.text?.trim() && !(req.body?.attachments || []).length) {
      res.status(400).json({ message: "Enter a prompt or attach at least one file." });
      return;
    }

    const debugScenario = parseDebugHarness(req.body?.debug);
    if (debugScenario) {
      await handleDebugScenario(res, req.body, debugScenario);
      return;
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      res.status(500).json({ message: "GROK_API_KEY is missing from .env." });
      return;
    }

    const payload = buildPayload(req.body);

    try {
      const upstream = await fetchImpl(RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        res.status(upstream.status).json(normalizeUpstreamError(upstream.status, text));
        return;
      }

      setStreamHeaders(res);

      const decoder = new TextDecoder();
      let buffer = "";
      let finalResponse = null;
      let accumulatedText = "";
      const toolCounts = { web_search: 0, x_search: 0, code_interpreter: 0 };
      const seenToolEvents = new Set();
      let agentProgressSent = false;
      const mode = req.body?.mode === "agent" ? "agent" : "standard";

      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });

        while (buffer.includes("\n\n")) {
          const index = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);

          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (!data || data === "[DONE]") {
            continue;
          }

          const value = JSON.parse(data);
          const delta = responseTextDelta(value);
          if (delta) {
            accumulatedText += delta;
            writeEvent(res, { type: "delta", delta });
          }

          const eventType = String(value?.type || "");
          const tool =
            toolFromEventType(eventType) ||
            toolFromEventType(value?.item?.type) ||
            toolFromEventType(value?.output_item?.type) ||
            toolFromEventType(value?.item?.name) ||
            toolFromEventType(value?.output_item?.name) ||
            toolFromEventType(value?.item?.call_id) ||
            toolFromEventType(value?.output_item?.call_id) ||
            toolFromEventType(value?.item_id);

          if (tool) {
            const itemId =
              value?.item_id ||
              value?.item?.id ||
              value?.output_item?.id ||
              value?.item?.call_id ||
              value?.output_item?.call_id ||
              `${tool}-${eventType}`;

            let status = null;
            if (eventType.endsWith(".in_progress") || eventType === "response.output_item.added") {
              status = "started";
            } else if (eventType.endsWith(".searching")) {
              status = "searching";
            } else if (eventType.endsWith(".interpreting")) {
              status = "interpreting";
            } else if (eventType.endsWith(".completed") || eventType === "response.output_item.done") {
              status = "completed";
            }

            if (status) {
              const eventKey = `${itemId}:${status}`;
              if (!seenToolEvents.has(eventKey)) {
                seenToolEvents.add(eventKey);
                if (status === "completed") {
                  toolCounts[tool] += 1;
                }
                writeEvent(res, {
                  type: "tool",
                  tool,
                  label: toolLabel(tool),
                  status,
                });
              }
            }
          }

          if (mode === "agent" && !agentProgressSent && eventType === "response.created") {
            agentProgressSent = true;
            writeEvent(res, {
              type: "agent",
              phase: "progress",
              detail:
                req.body.agentDepth === "16"
                  ? "Deep multi-agent research is running."
                  : "Quick multi-agent research is running.",
            });
          }

          if (value?.type === "response.completed" && value.response) {
            finalResponse = value.response;
          } else if (value?.id && value?.output) {
            finalResponse = value;
          }
        }
      }

      if (!finalResponse) {
        finalResponse = { output: [] };
      }

      if (!accumulatedText) {
        accumulatedText = extractOutputText(finalResponse);
      }

      const usage = buildUsage(mode, finalResponse, toolCounts);
      writeEvent(res, {
        type: "done",
        message: accumulatedText,
        responseId: finalResponse.id || null,
        modelAlias: payload.model,
        usage,
      });
      res.end();
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unexpected server error.",
      });
    }
  });

  app.use((req, res, next) => {
    const distPath = path.join(__dirname, "dist");
    if (req.method === "GET" && fs.existsSync(path.join(distPath, "index.html"))) {
      express.static(distPath)(req, res, next);
      return;
    }
    next();
  });

  return app;
}

const app = createApp();

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, () => {
    console.log(`Grok web server listening on http://localhost:${PORT}`);
  });
}
