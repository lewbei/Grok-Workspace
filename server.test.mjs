import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./server.mjs";

let server;
let baseUrl = "";

beforeAll(async () => {
  process.env.GROK_API_KEY = process.env.GROK_API_KEY || "debug-key";
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

async function postChat(body) {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "hello",
      mode: "standard",
      reasoningEnabled: false,
      agentDepth: "4",
      enabledTools: [],
      attachments: [],
      ...body,
    }),
  });
}

describe("/api/chat debug harness", () => {
  it("simulates 401 invalid key", async () => {
    const response = await postChat({ debug: { scenario: "unauthorized" } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_api_key",
      message: "xAI rejected the configured API key.",
    });
  });

  it("simulates 403 policy blocked", async () => {
    const response = await postChat({ debug: { scenario: "forbidden" } });
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.code).toBe("policy_blocked");
  });

  it("simulates 429 rate limiting", async () => {
    const response = await postChat({ debug: { scenario: "rate_limit" } });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      code: "rate_limited",
      message: "xAI rate-limited the request.",
    });
  });

  it("simulates 5xx upstream unavailable", async () => {
    const response = await postChat({ debug: { scenario: "upstream_5xx" } });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "upstream_unavailable",
      message: "xAI is temporarily unavailable.",
    });
  });

  it("simulates a malformed stream", async () => {
    const response = await postChat({ debug: { scenario: "malformed_stream" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await response.text();
    expect(text).toContain("not-json");
  });

  it("simulates a slow stream", async () => {
    const startedAt = Date.now();
    const response = await postChat({ debug: { scenario: "slow_stream", delayMs: 120 } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(text).toContain('"type":"delta"');
    expect(text).toContain('"type":"done"');
  });

  it("simulates a dropped connection", async () => {
    try {
      const response = await postChat({ debug: { scenario: "dropped_connection" } });
      await expect(response.text()).rejects.toThrow();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
