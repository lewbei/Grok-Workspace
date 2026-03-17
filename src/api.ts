import type {
  AgentDepth,
  AppSettings,
  AttachmentRecord,
  BrowserAttachment,
  ChatMode,
  FrontendTheme,
  FrontendToolName,
  MessageRecord,
  ProjectRecord,
  ResponseUsage,
  ThreadRecord,
  WorkspaceRecord,
} from "./types";

const STORAGE_KEYS = {
  theme: "grok-web.theme",
  workspace: "grok-web.workspace",
  threads: "grok-web.threads",
};

const ATTACHMENT_FILTERS = [
  {
    name: "Text and code",
    extensions: [
      "txt",
      "md",
      "py",
      "rs",
      "ts",
      "tsx",
      "js",
      "jsx",
      "json",
      "yaml",
      "yml",
      "toml",
      "csv",
      "html",
      "css",
      "sql",
      "java",
      "cpp",
      "c",
      "h",
      "hpp",
      "go",
      "swift",
      "kt",
      "sh",
      "ps1",
      "xml",
    ],
  },
];

type CommandError = Error & {
  code?: string;
  status?: number;
};

type ListenUnsubscribe = () => void;
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type TauriListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<ListenUnsubscribe>;
type TauriOpen = (options?: Record<string, unknown>) => Promise<string | string[] | null>;

interface TauriBridge {
  invoke: TauriInvoke;
  listen: TauriListen;
  open: TauriOpen;
}

export interface ChatStreamArgs {
  text: string;
  mode: ChatMode;
  reasoningEnabled: boolean;
  agentDepth: AgentDepth;
  enabledTools: FrontendToolName[];
  previousResponseId?: string | null;
  attachments: BrowserAttachment[];
  historyMessages?: Array<{
    role: "user" | "assistant";
    text: string;
    attachments?: BrowserAttachment[];
  }>;
  signal?: AbortSignal;
  debugScenario?: string | null;
  threadId?: string;
}

export interface ChatStreamEventDelta {
  type: "delta";
  delta: string;
}

export interface ChatStreamEventTool {
  type: "tool";
  tool: FrontendToolName;
  label: string;
  status: string;
}

export interface ChatStreamEventAgent {
  type: "agent";
  phase: string;
  detail: string;
}

export interface ChatStreamEventDone {
  type: "done";
  message: string;
  responseId?: string | null;
  modelAlias: string;
  usage: ResponseUsage;
}

export type ChatStreamEvent =
  | ChatStreamEventDelta
  | ChatStreamEventTool
  | ChatStreamEventAgent
  | ChatStreamEventDone;

interface DesktopSendResponse {
  requestId: string;
  workspace: WorkspaceRecord;
}

interface DesktopDeltaPayload {
  requestId: string;
  delta: string;
}

interface DesktopToolPayload {
  requestId: string;
  tool: FrontendToolName;
  label: string;
  status: string;
}

interface DesktopAgentPayload {
  requestId: string;
  phase: string;
  detail: string;
}

interface DesktopUsagePayload {
  requestId: string;
  usage: ResponseUsage;
}

interface DesktopDonePayload {
  requestId: string;
  cancelled: boolean;
  message?: string | null;
  responseId?: string | null;
  modelAlias?: string | null;
  usage?: ResponseUsage | null;
}

interface DesktopErrorPayload {
  requestId: string;
  code?: string | null;
  message: string;
}

let tauriBridgePromise: Promise<TauriBridge> | null = null;

function createStorageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `storage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function createDefaultUsage(): ResponseUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    toolCalls: [],
    estimatedCosts: {
      inputUsd: 0,
      outputUsd: 0,
      reasoningUsd: 0,
      cachedInputUsd: 0,
      toolsUsd: 0,
      totalUsd: 0,
    },
    billedTotalUsd: null,
  };
}

function sanitizeProjectRecord(value: unknown): ProjectRecord | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    name: typeof value.name === "string" && value.name.trim() ? value.name : "Workspace",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function sanitizeUsage(value: unknown): ResponseUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    inputTokens: typeof value.inputTokens === "number" ? value.inputTokens : 0,
    outputTokens: typeof value.outputTokens === "number" ? value.outputTokens : 0,
    reasoningTokens: typeof value.reasoningTokens === "number" ? value.reasoningTokens : 0,
    cachedInputTokens: typeof value.cachedInputTokens === "number" ? value.cachedInputTokens : 0,
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls
          .filter(isRecord)
          .map((tool) => ({
            tool:
              tool.tool === "x_search" || tool.tool === "code_interpreter" ? tool.tool : "web_search",
            count: typeof tool.count === "number" ? tool.count : 0,
          }))
      : [],
    estimatedCosts: isRecord(value.estimatedCosts)
      ? {
          inputUsd:
            typeof value.estimatedCosts.inputUsd === "number" ? value.estimatedCosts.inputUsd : 0,
          outputUsd:
            typeof value.estimatedCosts.outputUsd === "number" ? value.estimatedCosts.outputUsd : 0,
          reasoningUsd:
            typeof value.estimatedCosts.reasoningUsd === "number"
              ? value.estimatedCosts.reasoningUsd
              : 0,
          cachedInputUsd:
            typeof value.estimatedCosts.cachedInputUsd === "number"
              ? value.estimatedCosts.cachedInputUsd
              : 0,
          toolsUsd:
            typeof value.estimatedCosts.toolsUsd === "number" ? value.estimatedCosts.toolsUsd : 0,
          totalUsd:
            typeof value.estimatedCosts.totalUsd === "number" ? value.estimatedCosts.totalUsd : 0,
        }
      : createDefaultUsage().estimatedCosts,
    billedTotalUsd: typeof value.billedTotalUsd === "number" ? value.billedTotalUsd : null,
  };
}

function sanitizeMessageRecord(value: unknown): MessageRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.role !== "string") {
    return null;
  }

  return {
    id: value.id,
    role: value.role === "assistant" ? "assistant" : "user",
    text: typeof value.text === "string" ? value.text : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    status:
      value.status === "pending" ||
      value.status === "streaming" ||
      value.status === "completed" ||
      value.status === "cancelled" ||
      value.status === "error"
        ? value.status
        : "completed",
    mode: value.mode === "agent" ? "agent" : "standard",
    reasoningEnabled: Boolean(value.reasoningEnabled),
    agentDepth: value.agentDepth === "16" ? "16" : value.agentDepth === "4" ? "4" : null,
    selectedModelAlias: typeof value.selectedModelAlias === "string" ? value.selectedModelAlias : null,
    enabledTools: asStringArray(value.enabledTools).filter(
      (tool): tool is FrontendToolName =>
        tool === "web_search" || tool === "x_search" || tool === "code_interpreter",
    ),
    invokedTools: Array.isArray(value.invokedTools)
      ? value.invokedTools
          .filter(isRecord)
          .map((tool) => ({
            tool:
              tool.tool === "x_search" || tool.tool === "code_interpreter" ? tool.tool : "web_search",
            label: typeof tool.label === "string" ? tool.label : "Tool",
            status: typeof tool.status === "string" ? tool.status : "completed",
          }))
      : [],
    attachments: Array.isArray(value.attachments)
      ? value.attachments
          .filter(isRecord)
          .map((attachment) => ({
            id: typeof attachment.id === "string" ? attachment.id : createStorageId(),
            name: typeof attachment.name === "string" ? attachment.name : "attachment.txt",
            path: typeof attachment.path === "string" ? attachment.path : "",
            sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : 0,
          }))
      : [],
    usage: sanitizeUsage(value.usage),
    error: typeof value.error === "string" ? value.error : null,
    requestId: typeof value.requestId === "string" ? value.requestId : null,
    responseId: typeof value.responseId === "string" ? value.responseId : null,
  };
}

function sanitizeThreadRecord(value: unknown, fallbackProjectId: string): ThreadRecord | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  const messages = Array.isArray(value.messages)
    ? value.messages
        .map(sanitizeMessageRecord)
        .filter((message): message is NonNullable<typeof message> => Boolean(message))
    : [];

  return {
    id: value.id,
    projectId:
      typeof value.projectId === "string" && value.projectId.trim()
        ? value.projectId
        : fallbackProjectId,
    title: typeof value.title === "string" && value.title.trim() ? value.title : "New chat",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    lastResponseId: typeof value.lastResponseId === "string" ? value.lastResponseId : null,
    continuationLost: Boolean(value.continuationLost),
    contextStatus:
      value.contextStatus === "fresh_context" || value.contextStatus === "lost"
        ? value.contextStatus
        : "normal",
    contextDetail: typeof value.contextDetail === "string" ? value.contextDetail : null,
    messages,
  };
}

function parseJsonString(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseStreamLine(line: string) {
  try {
    return JSON.parse(line) as ChatStreamEvent;
  } catch {
    const error = new Error("Malformed streaming response from the local Grok server.") as CommandError;
    error.code = "malformed_stream";
    throw error;
  }
}

function abortedError() {
  const error = new Error("Request stopped.") as CommandError;
  error.code = "aborted";
  return error;
}

function createDefaultProject(): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: createStorageId(),
    name: "Grok",
    createdAt: now,
    updatedAt: now,
  };
}

function hydrateLegacyWorkspace(rawThreads: unknown): WorkspaceRecord {
  const defaultProject = createDefaultProject();
  const threads = Array.isArray(rawThreads)
    ? rawThreads
        .map((thread) => sanitizeThreadRecord(thread, defaultProject.id))
        .filter((thread): thread is ThreadRecord => Boolean(thread))
    : [];

  return {
    projects: [defaultProject],
    threads,
  };
}

function sanitizeWorkspaceRecord(value: unknown): WorkspaceRecord {
  if (!isRecord(value) || !Array.isArray(value.projects) || !Array.isArray(value.threads)) {
    return hydrateLegacyWorkspace(null);
  }

  const fallbackProject = createDefaultProject();
  const projects = value.projects
    .map(sanitizeProjectRecord)
    .filter((project): project is ProjectRecord => Boolean(project));
  const usableProjects = projects.length > 0 ? projects : [fallbackProject];
  const projectIds = new Set(usableProjects.map((project) => project.id));
  const threads = value.threads
    .map((thread) => sanitizeThreadRecord(thread, usableProjects[0].id))
    .filter((thread): thread is ThreadRecord => Boolean(thread))
    .map((thread) =>
      projectIds.has(thread.projectId) ? thread : { ...thread, projectId: usableProjects[0].id },
    );

  return { projects: usableProjects, threads };
}

export function isDesktopRuntime() {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function loadTauriBridge(): Promise<TauriBridge> {
  if (!tauriBridgePromise) {
    tauriBridgePromise = Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
      import("@tauri-apps/plugin-dialog"),
    ]).then(([core, event, dialog]) => ({
      invoke: core.invoke as TauriInvoke,
      listen: event.listen as TauriListen,
      open: dialog.open as TauriOpen,
    }));
  }
  return tauriBridgePromise;
}

export async function loadSettings(): Promise<AppSettings> {
  if (isDesktopRuntime()) {
    const { invoke } = await loadTauriBridge();
    return invoke<AppSettings>("load_settings");
  }

  const response = await fetch("/api/health");
  const server = (await response.json()) as AppSettings;
  return {
    ...server,
    theme: (localStorage.getItem(STORAGE_KEYS.theme) as FrontendTheme | null) || "system",
  };
}

export async function saveTheme(theme: FrontendTheme) {
  if (isDesktopRuntime()) {
    const { invoke } = await loadTauriBridge();
    await invoke("save_theme", { args: { theme } });
    return;
  }
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

export async function saveApiKey(apiKey: string) {
  if (!isDesktopRuntime()) {
    const error = new Error("Saving API keys is only supported in the desktop app.") as CommandError;
    error.code = "desktop_only";
    throw error;
  }
  const { invoke } = await loadTauriBridge();
  await invoke("save_api_key", { args: { apiKey } });
}

export async function removeApiKey() {
  if (!isDesktopRuntime()) {
    const error = new Error("Removing API keys is only supported in the desktop app.") as CommandError;
    error.code = "desktop_only";
    throw error;
  }
  const { invoke } = await loadTauriBridge();
  await invoke("remove_api_key");
}

export async function loadWorkspaceFromStorage(): Promise<WorkspaceRecord> {
  if (isDesktopRuntime()) {
    const { invoke } = await loadTauriBridge();
    const workspace = await invoke<WorkspaceRecord>("load_workspace");
    return sanitizeWorkspaceRecord(workspace);
  }

  const workspaceRaw = localStorage.getItem(STORAGE_KEYS.workspace);
  if (workspaceRaw) {
    try {
      return sanitizeWorkspaceRecord(JSON.parse(workspaceRaw));
    } catch {
      return hydrateLegacyWorkspace(null);
    }
  }

  const legacyRaw = localStorage.getItem(STORAGE_KEYS.threads);
  if (!legacyRaw) {
    const defaultProject = createDefaultProject();
    return { projects: [defaultProject], threads: [] };
  }

  try {
    const parsed = JSON.parse(legacyRaw);
    return hydrateLegacyWorkspace(parsed);
  } catch {
    const defaultProject = createDefaultProject();
    return { projects: [defaultProject], threads: [] };
  }
}

export async function saveWorkspaceToStorage(workspace: WorkspaceRecord) {
  if (isDesktopRuntime()) {
    const { invoke } = await loadTauriBridge();
    await invoke("save_workspace", { args: { workspace } });
    return;
  }
  localStorage.setItem(STORAGE_KEYS.workspace, JSON.stringify(workspace));
}

export async function pickDesktopAttachments(): Promise<BrowserAttachment[]> {
  if (!isDesktopRuntime()) {
    return [];
  }

  const { open, invoke } = await loadTauriBridge();
  const selected = await open({
    title: "Attach text or code files",
    multiple: true,
    filters: ATTACHMENT_FILTERS,
  });

  const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
  if (paths.length === 0) {
    return [];
  }

  const described = await invoke<AttachmentRecord[]>("describe_attachment_paths", {
    args: { attachmentPaths: paths },
  });

  return described.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    path: attachment.path,
  }));
}

async function streamDesktopChat(
  args: ChatStreamArgs,
  onEvent: (event: ChatStreamEvent) => void,
  onStarted?: (workspace: WorkspaceRecord) => void | Promise<void>,
) {
  if (!args.threadId) {
    throw new Error("Desktop chat requires a thread id.");
  }

  const { invoke, listen } = await loadTauriBridge();
  let requestId: string | null = null;
  let latestUsage: ResponseUsage | null = null;
  let accumulated = "";
  let settled = false;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((error: unknown) => void) | null = null;

  const finishPromise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const settleResolve = () => {
    if (settled) return;
    settled = true;
    resolveDone?.();
  };

  const settleReject = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectDone?.(error);
  };

  const toError = (payload: { code?: string | null; message: string }) => {
    const error = new Error(payload.message) as CommandError;
    if (typeof payload.code === "string") {
      error.code = payload.code;
    }
    return error;
  };

  const listeners = await Promise.all([
    listen<DesktopDeltaPayload>("chat:delta", (event) => {
      if (requestId && event.payload.requestId !== requestId) return;
      accumulated += event.payload.delta;
      onEvent({ type: "delta", delta: event.payload.delta });
    }),
    listen<DesktopToolPayload>("chat:tool", (event) => {
      if (requestId && event.payload.requestId !== requestId) return;
      onEvent({
        type: "tool",
        tool: event.payload.tool,
        label: event.payload.label,
        status: event.payload.status,
      });
    }),
    listen<DesktopAgentPayload>("chat:agent", (event) => {
      if (requestId && event.payload.requestId !== requestId) return;
      onEvent({
        type: "agent",
        phase: event.payload.phase,
        detail: event.payload.detail,
      });
    }),
    listen<DesktopUsagePayload>("chat:usage", (event) => {
      if (requestId && event.payload.requestId !== requestId) return;
      latestUsage = event.payload.usage;
    }),
    listen<DesktopErrorPayload>("chat:error", (event) => {
      if (requestId && event.payload.requestId !== requestId) return;
      settleReject(
        event.payload.code === "cancelled" ? abortedError() : toError(event.payload),
      );
    }),
    listen<DesktopDonePayload>("chat:done", (event) => {
      if (requestId && event.payload.requestId !== requestId) return;
      if (event.payload.cancelled) {
        settleReject(abortedError());
        return;
      }

      const usage = event.payload.usage || latestUsage || createDefaultUsage();
      onEvent({
        type: "done",
        message: event.payload.message || accumulated,
        responseId: event.payload.responseId || null,
        modelAlias:
          event.payload.modelAlias ||
          modelLabel(args.mode, args.reasoningEnabled, args.mode === "agent" ? args.agentDepth : null),
        usage,
      });
      settleResolve();
    }),
  ]);

  const cleanup = async () => {
    await Promise.allSettled(listeners.map((unlisten) => Promise.resolve(unlisten())));
  };

  const abortCurrent = () => {
    if (requestId) {
      void invoke("cancel_request", { args: { requestId } });
    }
  };

  if (args.signal) {
    if (args.signal.aborted) {
      await cleanup();
      throw abortedError();
    }
    args.signal.addEventListener("abort", abortCurrent, { once: true });
  }

  try {
    const response = await invoke<DesktopSendResponse>("send_message", {
      args: {
        threadId: args.threadId,
        text: args.text,
        attachmentPaths: args.attachments.map((attachment) => attachment.path).filter(Boolean),
        mode: args.mode,
        reasoningEnabled: args.reasoningEnabled,
        agentDepth: args.mode === "agent" ? args.agentDepth : null,
        enabledTools: args.enabledTools,
        debugScenario: args.debugScenario || null,
      },
    });
    requestId = response.requestId;
    if (onStarted) {
      await onStarted(sanitizeWorkspaceRecord(response.workspace));
    }

    if (args.signal?.aborted) {
      abortCurrent();
    }

    await finishPromise;
  } finally {
    if (args.signal) {
      args.signal.removeEventListener("abort", abortCurrent);
    }
    await cleanup();
  }
}

export async function streamChat(
  args: ChatStreamArgs,
  onEvent: (event: ChatStreamEvent) => void,
  onStarted?: (workspace: WorkspaceRecord) => void | Promise<void>,
) {
  if (isDesktopRuntime()) {
    return streamDesktopChat(args, onEvent, onStarted);
  }

  let response: Response;

  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: args.signal,
      body: JSON.stringify({
        text: args.text,
        mode: args.mode,
        reasoningEnabled: args.reasoningEnabled,
        agentDepth: args.agentDepth,
        enabledTools: args.enabledTools,
        previousResponseId: args.previousResponseId,
        attachments: args.attachments,
        historyMessages: args.historyMessages,
        debug: args.debugScenario ? { scenario: args.debugScenario } : null,
      }),
    });
  } catch (error) {
    if ((error instanceof DOMException && error.name === "AbortError") || args.signal?.aborted) {
      throw abortedError();
    }
    throw error;
  }

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.message || "Request failed.") as CommandError;
    if (typeof payload?.code === "string") {
      error.code = payload.code;
    }
    error.status = response.status;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) {
          continue;
        }
        onEvent(parseStreamLine(line));
      }
    }
  } catch (error) {
    if ((error instanceof DOMException && error.name === "AbortError") || args.signal?.aborted) {
      throw abortedError();
    }
    throw error;
  }

  if (buffer.trim()) {
    onEvent(parseStreamLine(buffer.trim()));
  }
}

export function getCommandErrorCode(error: unknown) {
  if (isRecord(error) && typeof error.code === "string") {
    return error.code;
  }
  return null;
}

export function formatCommandError(error: unknown) {
  const code = getCommandErrorCode(error);
  if (code === "aborted") {
    return "Request stopped.";
  }
  if (code === "desktop_only") {
    return "This action only works in the desktop app.";
  }
  if (code === "invalid_api_key") {
    return isDesktopRuntime()
      ? "The saved xAI API key was rejected. Update it in Settings and retry."
      : "The configured `GROK_API_KEY` was rejected by xAI. Check `.env` and restart the local server.";
  }
  if (code === "rate_limited") {
    return "xAI rate-limited this request. Wait a moment and try again.";
  }
  if (code === "invalid_previous_response_id") {
    return "This thread lost server-side continuation. The next send will start a fresh model context unless you restate prior context.";
  }
  if (code === "policy_blocked") {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    return `xAI blocked this request under usage policy.${detail}`.trim();
  }
  if (code === "upstream_unavailable") {
    return "xAI is temporarily unavailable. Retry in a moment.";
  }
  if (code === "malformed_stream") {
    return "The local Grok server returned an invalid streaming response. Retry the request.";
  }
  if (code === "proxy_dropped") {
    return "The local Grok server dropped the response before completion. Retry the request.";
  }

  if (typeof error === "string") {
    if (error.includes("Failed to fetch")) {
      return isDesktopRuntime()
        ? "Cannot reach the desktop Grok runtime. Restart the app and try again."
        : "Cannot reach the local Grok server. Make sure `npm run dev` is still running and refresh the page.";
    }
    const parsed = parseJsonString(error);
    if (parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
    return error;
  }

  if (error instanceof Error) {
    if (error.message.includes("Failed to fetch")) {
      return isDesktopRuntime()
        ? "Cannot reach the desktop Grok runtime. Restart the app and try again."
        : "Cannot reach the local Grok server. Make sure `npm run dev` is still running and refresh the page.";
    }
    const parsed = parseJsonString(error.message);
    if (parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
    return error.message;
  }

  return "Unexpected error";
}

export function modelLabel(mode: ChatMode, reasoningEnabled: boolean, agentDepth?: string | null) {
  if (mode === "agent") {
    return `Grok 4.20 Multi-agent (${agentDepth === "16" ? "16" : "4"} agents)`;
  }

  return reasoningEnabled ? "Grok 4.20 Beta (reasoning)" : "Grok 4.20 Beta";
}
