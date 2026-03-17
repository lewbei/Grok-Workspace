import { describe, expect, it } from "vitest";

import {
  buildPayload,
  buildUsage,
  normalizeUpstreamError,
  parseDebugHarness,
  toolFromEventType,
} from "./server-lib.mjs";

describe("buildPayload", () => {
  it("keeps tools in agent mode and includes previous_response_id", () => {
    const payload = buildPayload({
      text: "hello",
      mode: "agent",
      reasoningEnabled: false,
      agentDepth: "16",
      enabledTools: ["web_search", "code_interpreter"],
      previousResponseId: "resp-123",
      attachments: [],
    });

    expect(payload.model).toBe("grok-4.20-multi-agent-beta-0309");
    expect(payload.previous_response_id).toBe("resp-123");
    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload.tools).toEqual([{ type: "web_search" }, { type: "code_interpreter" }]);
  });
});

describe("buildUsage", () => {
  it("uses xAI server-side tool usage details as the source of truth", () => {
    const usage = buildUsage(
      "agent",
      {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
          input_tokens_details: { cached_tokens: 10 },
          server_side_tool_usage_details: {
            web_search_calls: 3,
            x_search_calls: 0,
            code_interpreter_calls: 4,
          },
        },
      },
      { web_search: 1, x_search: 0, code_interpreter: 1 },
    );

    expect(usage.toolCalls).toEqual([
      { tool: "web_search", count: 3 },
      { tool: "code_interpreter", count: 4 },
    ]);
    expect(usage.estimatedCosts.toolsUsd).toBe(0.035);
  });
});

describe("normalizeUpstreamError", () => {
  it("maps 429 to rate_limited", () => {
    expect(normalizeUpstreamError(429, '{"message":"Too many requests"}')).toEqual({
      code: "rate_limited",
      message: "xAI rate-limited the request.",
    });
  });

  it("maps 5xx to upstream_unavailable", () => {
    expect(normalizeUpstreamError(503, '{"message":"upstream unavailable"}')).toEqual({
      code: "upstream_unavailable",
      message: "xAI is temporarily unavailable.",
    });
  });

  it("detects invalid previous response failures", () => {
    expect(
      normalizeUpstreamError(400, '{"message":"previous_response_id is invalid for this request"}'),
    ).toEqual({
      code: "invalid_previous_response_id",
      message:
        "This thread lost server-side continuation. Resend with the needed context or start a new thread.",
    });
  });

  it("detects policy blocked failures from nested xAI JSON", () => {
    const result = normalizeUpstreamError(
      403,
      '{"message":"{\"error\":\"Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_BIO\"}"}',
    );

    expect(result.code).toBe("policy_blocked");
    expect(result.message).toContain("violates usage guidelines");
  });
});

describe("toolFromEventType", () => {
  it("recognizes x search custom tool call names and ids", () => {
    expect(toolFromEventType("x_keyword_search")).toBe("x_search");
    expect(toolFromEventType("xs_0")).toBe("x_search");
  });
});

describe("parseDebugHarness", () => {
  it("accepts supported scenarios and clamps delay", () => {
    expect(parseDebugHarness({ scenario: "slow_stream", delayMs: 10_000 })).toEqual({
      scenario: "slow_stream",
      delayMs: 5000,
    });
  });

  it("rejects unsupported scenarios", () => {
    expect(parseDebugHarness({ scenario: "nope" })).toBeNull();
  });
});
