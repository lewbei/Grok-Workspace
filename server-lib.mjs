export const PRICING_CONFIG_VERSION = "2026-03-xai-estimated-v1";
export const DEBUG_SCENARIOS = [
  "unauthorized",
  "forbidden",
  "rate_limit",
  "upstream_5xx",
  "malformed_stream",
  "slow_stream",
  "dropped_connection",
];

export const PRICING = {
  standard: {
    inputPerMillion: 3,
    cachedInputPerMillion: 0.75,
    outputPerMillion: 15,
    reasoningPerMillion: 15,
  },
  agent: {
    inputPerMillion: 3,
    cachedInputPerMillion: 0.75,
    outputPerMillion: 15,
    reasoningPerMillion: 15,
  },
  webCall: 0.005,
  xCall: 0.005,
  codeCall: 0.005,
};

function roundCurrency(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJsonLike(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractNestedError(text) {
  const first = parseJsonLike(text);
  if (first && typeof first.message === "string") {
    const nested = parseJsonLike(first.message);
    if (nested) {
      return nested;
    }
  }
  return first;
}

export function resolveModelAlias(mode, reasoningEnabled) {
  if (mode === "agent") {
    return "grok-4.20-multi-agent-beta-0309";
  }
  return reasoningEnabled
    ? "grok-4.20-beta-latest"
    : "grok-4.20-beta-latest-non-reasoning";
}

export function estimateCosts({
  mode,
  inputTokens,
  outputTokens,
  reasoningTokens,
  cachedInputTokens,
  webCalls,
  xCalls,
  codeCalls,
  billedTotalUsd,
}) {
  const profile = mode === "agent" ? PRICING.agent : PRICING.standard;
  const inputUsd = (inputTokens / 1_000_000) * profile.inputPerMillion;
  const cachedInputUsd = (cachedInputTokens / 1_000_000) * profile.cachedInputPerMillion;
  const outputUsd = (outputTokens / 1_000_000) * profile.outputPerMillion;
  const reasoningUsd = (reasoningTokens / 1_000_000) * profile.reasoningPerMillion;
  const toolsUsd = webCalls * PRICING.webCall + xCalls * PRICING.xCall + codeCalls * PRICING.codeCall;
  const estimatedTotal = inputUsd + cachedInputUsd + outputUsd + reasoningUsd + toolsUsd;

  return {
    inputUsd: roundCurrency(inputUsd),
    outputUsd: roundCurrency(outputUsd),
    reasoningUsd: roundCurrency(reasoningUsd),
    cachedInputUsd: roundCurrency(cachedInputUsd),
    toolsUsd: roundCurrency(toolsUsd),
    totalUsd: roundCurrency(billedTotalUsd ?? estimatedTotal),
  };
}

export function toolLabel(tool) {
  if (tool === "web_search") return "Web";
  if (tool === "x_search") return "X";
  return "Code";
}

export function toolFromEventType(value) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("web_search") || lower.includes("websearch")) return "web_search";
  if (
    lower.includes("x_search") ||
    lower.includes("xsearch") ||
    lower.includes("x_keyword_search") ||
    lower.startsWith("xs_")
  ) {
    return "x_search";
  }
  if (lower.includes("code_interpreter") || lower.includes("code_execution")) return "code_interpreter";
  return null;
}

export function toolCountsFromUsage(usage) {
  const details = usage?.server_side_tool_usage_details || {};
  return {
    web_search: Number(details.web_search_calls || 0),
    x_search: Number(details.x_search_calls || 0),
    code_interpreter: Number(details.code_interpreter_calls || 0),
  };
}

export function responseTextDelta(value) {
  if (value?.type === "response.output_text.delta" && typeof value.delta === "string") {
    return value.delta;
  }
  if (typeof value?.choices?.[0]?.delta?.content === "string") {
    return value.choices[0].delta.content;
  }
  if (typeof value?.choices?.[0]?.delta?.content?.[0]?.text === "string") {
    return value.choices[0].delta.content[0].text;
  }
  return null;
}

export function extractOutputText(value) {
  return (value?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item?.text || "")
    .join("");
}

export function buildUsage(mode, response, streamedToolCounts) {
  const usage = response?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const reasoningTokens = Number(
    usage.reasoning_tokens || usage?.output_tokens_details?.reasoning_tokens || 0,
  );
  const cachedInputTokens = Number(
    usage.cached_input_tokens || usage?.input_tokens_details?.cached_tokens || 0,
  );
  const billedTotalUsd =
    typeof usage.cost_in_usd === "number"
      ? usage.cost_in_usd
      : typeof usage.total_cost_usd === "number"
        ? usage.total_cost_usd
        : null;

  const usageToolCounts = toolCountsFromUsage(usage);
  const webCalls = Math.max(streamedToolCounts.web_search || 0, usageToolCounts.web_search);
  const xCalls = Math.max(streamedToolCounts.x_search || 0, usageToolCounts.x_search);
  const codeCalls = Math.max(
    streamedToolCounts.code_interpreter || 0,
    usageToolCounts.code_interpreter,
  );

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    toolCalls: Object.entries({
      web_search: webCalls,
      x_search: xCalls,
      code_interpreter: codeCalls,
    })
      .filter(([, count]) => count > 0)
      .map(([tool, count]) => ({ tool, count })),
    estimatedCosts: estimateCosts({
      mode,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      webCalls,
      xCalls,
      codeCalls,
      billedTotalUsd,
    }),
    billedTotalUsd,
  };
}

export function buildPayload(body) {
  const {
    text,
    mode,
    reasoningEnabled,
    agentDepth,
    enabledTools = [],
    previousResponseId,
    attachments = [],
    historyMessages = [],
  } = body;

  const buildContent = (messageText, messageAttachments = []) => {
    const content = [];
    if (messageText?.trim()) {
      content.push({ type: "input_text", text: messageText.trim() });
    }

    for (const attachment of messageAttachments) {
      if (attachment?.content?.trim()) {
        content.push({
          type: "input_text",
          text: `Attachment: ${attachment.name}

${attachment.content}`,
        });
      }
    }

    return content;
  };

  const input = [];
  if (!previousResponseId && Array.isArray(historyMessages) && historyMessages.length > 0) {
    for (const message of historyMessages) {
      const content = buildContent(message?.text, message?.attachments || []);
      if (content.length > 0) {
        input.push({
          role: message?.role === "assistant" ? "assistant" : "user",
          content,
        });
      }
    }
  }

  const content = buildContent(text, attachments);
  if (content.length > 0) {
    input.push({ role: "user", content });
  }

  const payload = {
    model: resolveModelAlias(mode, Boolean(reasoningEnabled)),
    stream: true,
    input,
  };

  if (previousResponseId) {
    payload.previous_response_id = previousResponseId;
  }

  if (mode === "agent") {
    payload.reasoning = {
      effort: agentDepth === "16" ? "high" : "low",
    };
  }

  if (enabledTools.length > 0) {
    payload.tools = enabledTools.map((tool) => ({ type: tool }));
  }

  return payload;
}

export function normalizeUpstreamError(status, text) {
  const nested = extractNestedError(text);
  const rawMessage =
    (typeof nested?.error === "string" && nested.error) ||
    (typeof nested?.message === "string" && nested.message) ||
    (typeof text === "string" && text) ||
    "xAI request failed.";
  const lower = rawMessage.toLowerCase();

  if (status === 401) {
    return {
      code: "invalid_api_key",
      message: "xAI rejected the configured API key.",
    };
  }

  if (lower.includes("incorrect api key") || lower.includes("api key provided")) {
    return {
      code: "invalid_api_key",
      message: "xAI rejected the configured API key.",
    };
  }

  if (status === 429) {
    return {
      code: "rate_limited",
      message: "xAI rate-limited the request.",
    };
  }

  if (lower.includes("previous_response_id") || lower.includes("previous response")) {
    return {
      code: "invalid_previous_response_id",
      message:
        "This thread lost server-side continuation. Resend with the needed context or start a new thread.",
    };
  }

  if (lower.includes("violates usage guidelines") || lower.includes("safety_check")) {
    return {
      code: "policy_blocked",
      message: rawMessage.split("Team:")[0].trim(),
    };
  }

  if (status >= 500) {
    return {
      code: "upstream_unavailable",
      message: "xAI is temporarily unavailable.",
    };
  }

  return {
    code: "upstream_error",
    message: rawMessage,
  };
}

export function parseDebugHarness(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const scenario =
    typeof input.scenario === "string" && DEBUG_SCENARIOS.includes(input.scenario)
      ? input.scenario
      : null;

  if (!scenario) {
    return null;
  }

  const delayMs =
    typeof input.delayMs === "number" && Number.isFinite(input.delayMs)
      ? Math.min(Math.max(Math.trunc(input.delayMs), 0), 5_000)
      : 900;

  return {
    scenario,
    delayMs,
  };
}
