import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

import {
  formatCommandError,
  getCommandErrorCode,
  isDesktopRuntime,
  loadSettings,
  loadWorkspaceFromStorage,
  modelLabel,
  pickDesktopAttachments,
  removeApiKey,
  saveApiKey,
  saveTheme,
  saveWorkspaceToStorage,
  streamChat,
  type ChatStreamEvent,
} from "./api";
import type {
  AgentDepth,
  AppSettings,
  BrowserAttachment,
  FrontendTheme,
  FrontendToolName,
  MessageRecord,
  ProjectRecord,
  ResponseUsage,
  ThreadRecord,
  ThreadSummary,
  WorkspaceRecord,
  ToolActivity,
} from "./types";

const TOOL_OPTIONS: Array<{ id: FrontendToolName; label: string }> = [
  { id: "web_search", label: "Web" },
  { id: "x_search", label: "X" },
  { id: "code_interpreter", label: "Code" },
];
const STARTER_PROMPTS = [
  {
    title: "Research",
    prompt: "Help me break a complex project into clear phases, risks, and next actions.",
  },
  {
    title: "Compare",
    prompt: "Compare three strong options for this problem and tell me which one to choose.",
  },
  {
    title: "Write",
    prompt: "Draft a polished version of this idea, then make it sharper and easier to understand.",
  },
  {
    title: "Deep Research",
    prompt: "Investigate this thoroughly, look for tradeoffs, and come back with a confident recommendation.",
  },
] as const;

const DEBUG_SCENARIOS = [
  { id: "off", label: "Off" },
  { id: "unauthorized", label: "Simulate 401" },
  { id: "forbidden", label: "Simulate 403" },
  { id: "rate_limit", label: "Simulate 429" },
  { id: "upstream_5xx", label: "Simulate 500" },
  { id: "malformed_stream", label: "Malformed stream" },
  { id: "slow_stream", label: "Slow stream" },
  { id: "dropped_connection", label: "Drop connection" },
] as const;

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".html",
  ".css",
  ".sql",
  ".java",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".go",
  ".swift",
  ".kt",
  ".sh",
  ".ps1",
  ".xml",
]);
const MAX_ATTACHMENT_BYTES = 1_000_000;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
type DebugScenarioId = (typeof DEBUG_SCENARIOS)[number]["id"];
type ThreadContextStatus = "normal" | "fresh_context" | "lost";

interface ComposerDraft {
  text: string;
  mode: "standard" | "agent";
  reasoningEnabled: boolean;
  agentDepth: AgentDepth;
  enabledTools: FrontendToolName[];
  attachments: BrowserAttachment[];
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProject(name = "Grok"): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: createId(),
    name,
    createdAt: now,
    updatedAt: now,
  };
}

function createEmptyThread(projectId: string): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id: createId(),
    projectId,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    lastResponseId: null,
    continuationLost: false,
    contextStatus: "normal",
    contextDetail: null,
    messages: [],
  };
}

function toSummary(thread: ThreadRecord): ThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    updatedAt: thread.updatedAt,
    lastMessagePreview:
      [...thread.messages].reverse().find((message) => message.text.trim())?.text.slice(0, 110) ||
      null,
  };
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCurrency(value?: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value ?? 0);
}

function shortcutLabel(value: string) {
  if (typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform)) {
    return value.replace(/Ctrl/g, "Cmd");
  }
  return value;
}

function modeDisplayLabel(mode: "standard" | "agent") {
  return mode === "agent" ? "Deep Research" : "Chat";
}

function statusLabel(message: MessageRecord, agentEvents: string[]) {
  if (message.status === "pending" || message.status === "streaming") return "Streaming";
  if (message.status === "completed") return "Completed";
  if (message.status === "cancelled") return "Cancelled";
  if (message.status === "error") return "Error";
  return agentEvents.length > 0 ? agentEvents[agentEvents.length - 1] : null;
}

function contextLabel(status: ThreadContextStatus | undefined) {
  if (status === "fresh_context") return "Fresh model context";
  if (status === "lost") return "Continuation lost";
  return "Server continuation healthy";
}

function findRetrySource(messages: MessageRecord[], assistantMessageId: string) {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex <= 0) {
    return null;
  }

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message;
    }
  }

  return null;
}

function buildThreadExport(project: ProjectRecord | null, thread: ThreadRecord) {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      project,
      thread,
    },
    null,
    2,
  );
}

function buildHistoryMessages(messages: MessageRecord[]) {
  return messages
    .filter(
      (message) =>
        message.status === "completed" &&
        (message.text.trim().length > 0 || message.attachments.length > 0),
    )
    .map((message) => ({
      role: message.role,
      text: message.text,
      attachments:
        message.role === "user"
          ? message.attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              path: attachment.path,
              sizeBytes: attachment.sizeBytes,
            }))
          : [],
    }));
}

function sumThreadUsage(messages: MessageRecord[]): ResponseUsage | null {
  const usageMessages = messages.filter(
    (message): message is MessageRecord & { usage: ResponseUsage } =>
      message.role === "assistant" && Boolean(message.usage),
  );

  if (usageMessages.length === 0) {
    return null;
  }

  const toolCounts = new Map<FrontendToolName, number>();
  let billedTotalUsd = 0;
  let hasBilledTotal = false;

  for (const message of usageMessages) {
    for (const tool of message.usage.toolCalls) {
      toolCounts.set(tool.tool, (toolCounts.get(tool.tool) || 0) + tool.count);
    }
    if (typeof message.usage.billedTotalUsd === "number") {
      billedTotalUsd += message.usage.billedTotalUsd;
      hasBilledTotal = true;
    }
  }

  return {
    inputTokens: usageMessages.reduce((sum, message) => sum + message.usage.inputTokens, 0),
    outputTokens: usageMessages.reduce((sum, message) => sum + message.usage.outputTokens, 0),
    reasoningTokens: usageMessages.reduce((sum, message) => sum + message.usage.reasoningTokens, 0),
    cachedInputTokens: usageMessages.reduce((sum, message) => sum + message.usage.cachedInputTokens, 0),
    toolCalls: Array.from(toolCounts.entries()).map(([tool, count]) => ({ tool, count })),
    estimatedCosts: {
      inputUsd: usageMessages.reduce((sum, message) => sum + message.usage.estimatedCosts.inputUsd, 0),
      outputUsd: usageMessages.reduce((sum, message) => sum + message.usage.estimatedCosts.outputUsd, 0),
      reasoningUsd: usageMessages.reduce(
        (sum, message) => sum + message.usage.estimatedCosts.reasoningUsd,
        0,
      ),
      cachedInputUsd: usageMessages.reduce(
        (sum, message) => sum + message.usage.estimatedCosts.cachedInputUsd,
        0,
      ),
      toolsUsd: usageMessages.reduce((sum, message) => sum + message.usage.estimatedCosts.toolsUsd, 0),
      totalUsd: usageMessages.reduce((sum, message) => sum + message.usage.estimatedCosts.totalUsd, 0),
    },
    billedTotalUsd: hasBilledTotal ? billedTotalUsd : null,
  };
}

function downloadJson(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function filesToAttachments(fileList: FileList) {
  const files = Array.from(fileList);
  const attachments = await Promise.all(
    files.map(async (file) => {
      const extensionIndex = file.name.lastIndexOf(".");
      const extension = extensionIndex >= 0 ? file.name.slice(extensionIndex).toLowerCase() : "";
      if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported attachment type for "${file.name}". Use a text or code file.`);
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`"${file.name}" exceeds the 1 MB attachment limit.`);
      }

      const buffer = await file.arrayBuffer();
      try {
        return {
          id: createId(),
          name: file.name,
          sizeBytes: file.size,
          content: textDecoder.decode(buffer),
        } satisfies BrowserAttachment;
      } catch {
        throw new Error(`"${file.name}" could not be read as UTF-8 text.`);
      }
    }),
  );

  return attachments;
}

function App() {
  const desktopRuntime = isDesktopRuntime();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceRecord>({ projects: [], threads: [] });
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmWorkspaceReset, setConfirmWorkspaceReset] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverReachable, setServerReachable] = useState(true);
  const [threadQuery, setThreadQuery] = useState("");
  const [composerText, setComposerText] = useState("");
  const [composerMode, setComposerMode] = useState<"standard" | "agent">("standard");
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [agentDepth, setAgentDepth] = useState<AgentDepth>("4");
  const [enabledTools, setEnabledTools] = useState<FrontendToolName[]>([]);
  const [attachments, setAttachments] = useState<BrowserAttachment[]>([]);
  const [agentEvents, setAgentEvents] = useState<Record<string, string[]>>({});
  const [debugScenario, setDebugScenario] = useState<DebugScenarioId>("off");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const pendingRequestRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const settingsDialogRef = useRef<HTMLElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);

  const projects = useMemo(
    () => [...workspace.projects].sort((a, b) => a.name.localeCompare(b.name)),
    [workspace.projects],
  );
  const sortedThreads = useMemo(
    () => [...workspace.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [workspace.threads],
  );
  const activeThread = useMemo(
    () => workspace.threads.find((thread) => thread.id === activeThreadId) ?? null,
    [workspace.threads, activeThreadId],
  );
  const currentProjectId =
    activeThread?.projectId || activeProjectId || projects[0]?.id || "";

  const threadSummaries = useMemo(
    () => sortedThreads.map(toSummary),
    [sortedThreads],
  );
  const visibleThreads = useMemo(() => {
    const normalizedQuery = threadQuery.trim().toLowerCase();
    return threadSummaries.filter((thread) => {
      if (!normalizedQuery) {
        return true;
      }
      return (
        thread.title.toLowerCase().includes(normalizedQuery) ||
        String(thread.lastMessagePreview || "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [threadQuery, threadSummaries]);
  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        const loadedSettings = await loadSettings();
        const loadedWorkspace = await loadWorkspaceFromStorage();
        const projectsToUse =
          loadedWorkspace.projects.length > 0 ? loadedWorkspace.projects : [createProject()];
        const threadsToUse =
          loadedWorkspace.threads.length > 0
            ? loadedWorkspace.threads
            : [createEmptyThread(projectsToUse[0].id)];
        const latestThread = [...threadsToUse].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

        if (!mounted) return;

        startTransition(() => {
          setSettings(loadedSettings);
          setWorkspace({ projects: projectsToUse, threads: threadsToUse });
          setActiveThreadId(latestThread?.id || "");
          setActiveProjectId(latestThread?.projectId || projectsToUse[0].id);
          setServerReachable(true);
          setLoading(false);
        });
      } catch (error) {
        if (!mounted) return;
        setBanner(formatCommandError(error));
        setServerReachable(false);
        setLoading(false);
      }
    };

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (settings) {
      document.documentElement.dataset.theme = settings.theme;
    }
  }, [settings]);

  useEffect(() => {
    if (!settingsOpen) {
      setConfirmWorkspaceReset(false);
      return;
    }

    lastFocusedElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = settingsDialogRef.current;
    if (!dialog) {
      return;
    }

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0] || dialog;
    window.requestAnimationFrame(() => first.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute("disabled"));

      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstItem = items[0];
      const lastItem = items[items.length - 1];

      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      const previous = lastFocusedElementRef.current;
      if (previous && typeof previous.focus === "function") {
        window.requestAnimationFrame(() => previous.focus());
      }
    };
  }, [settingsOpen]);

  useEffect(() => {
    document.title = "Grok Control";
  }, []);

  useEffect(() => {
    if (workspace.projects.length > 0 && (!desktopRuntime || !pending)) {
      void saveWorkspaceToStorage(workspace).catch((error) => {
        setBanner(formatCommandError(error));
      });
    }
  }, [desktopRuntime, pending, workspace]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: pending ? "smooth" : "auto",
      });
    });

    return () => window.cancelAnimationFrame(handle);
  }, [activeThreadId, activeThread?.messages, agentEvents, pending]);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) {
      return;
    }

    const maxHeight = 260;
    node.style.height = "0px";
    const nextHeight = Math.min(node.scrollHeight, maxHeight);
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = node.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [activeThreadId, composerMode, composerText]);

  useEffect(() => {
    if (loading) {
      return undefined;
    }

    const refreshHealth = async () => {
      try {
        const nextSettings = await loadSettings();
        setSettings(nextSettings);
        setServerReachable(true);
      } catch {
        setServerReachable(false);
      }
    };

    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 30_000);

    return () => window.clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const activeElement = document.activeElement;
      const isTextInput =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement ||
        Boolean(activeElement instanceof HTMLElement && activeElement.isContentEditable);

      if (event.key === "Escape") {
        if (settingsOpen) {
          event.preventDefault();
          closeSettings();
          return;
        }
        if (banner) {
          event.preventDefault();
          setBanner(null);
        }
        return;
      }

      if (!modifier) {
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
        return;
      }

      if (event.key.toLowerCase() === "n" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handleNewThread();
        window.requestAnimationFrame(() => composerRef.current?.focus());
        return;
      }

      if (event.key === "," && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        openSettings();
        return;
      }

      if (event.key.toLowerCase() === "a" && event.shiftKey) {
        event.preventDefault();
        setComposerMode((current) => (current === "standard" ? "agent" : "standard"));
        return;
      }

      if (event.key.toLowerCase() === "r" && event.shiftKey && composerMode === "standard") {
        event.preventDefault();
        setReasoningEnabled((current) => !current);
        return;
      }

      if (event.key.toLowerCase() === "l" && !event.shiftKey && !event.altKey && !isTextInput) {
        event.preventDefault();
        composerRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeThreadId,
    agentDepth,
    attachments,
    banner,
    composerMode,
    composerText,
    enabledTools,
    pending,
    reasoningEnabled,
    settings?.apiKeyConfigured,
    settingsOpen,
  ]);

  function updateWorkspace(updater: (current: WorkspaceRecord) => WorkspaceRecord) {
    setWorkspace((current) => updater(current));
  }

  function updateThread(threadId: string, updater: (thread: ThreadRecord) => ThreadRecord) {
    updateWorkspace((current) => ({
      ...current,
      threads: current.threads.map((thread) => (thread.id === threadId ? updater(thread) : thread)),
    }));
  }

  function refreshProjectTimestamp(projectId: string) {
    updateWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId ? { ...project, updatedAt: new Date().toISOString() } : project,
      ),
    }));
  }

  function syncComposerWithMessage(message: MessageRecord) {
    setComposerText(message.text);
    setComposerMode(message.mode);
    setReasoningEnabled(message.mode === "standard" ? message.reasoningEnabled : false);
    setAgentDepth(message.mode === "agent" ? message.agentDepth || "4" : "4");
    setEnabledTools(message.enabledTools);
  }

  function handleNewThread(projectId = currentProjectId) {
    if (!projectId) {
      return;
    }
    const thread = createEmptyThread(projectId);
    updateWorkspace((current) => ({
      ...current,
      threads: [thread, ...current.threads],
    }));
    refreshProjectTimestamp(projectId);
    setActiveProjectId(projectId);
    setActiveThreadId(thread.id);
    setComposerText("");
    setAttachments([]);
    setBanner(null);
  }

  function handleDeleteThread(threadId: string) {
    const remaining = workspace.threads.filter((thread) => thread.id !== threadId);
    if (remaining.length === 0) {
      const fallbackProjectId = currentProjectId || workspace.projects[0]?.id || createProject().id;
      const thread = createEmptyThread(fallbackProjectId);
      setWorkspace((current) => ({
        ...current,
        threads: [thread],
      }));
      setActiveProjectId(fallbackProjectId);
      setActiveThreadId(thread.id);
      return;
    }

    setWorkspace((current) => ({
      ...current,
      threads: current.threads.filter((thread) => thread.id !== threadId),
    }));

    const nextThread =
      remaining.find((thread) => thread.projectId === currentProjectId) || remaining[0];
    setActiveProjectId(nextThread.projectId);
    setActiveThreadId(nextThread.id);
  }

  function handleExportThread() {
    if (!activeThread) {
      return;
    }
    const project = workspace.projects.find((entry) => entry.id === activeThread.projectId) ?? null;
    const safeTitle = activeThread.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    downloadJson(`${safeTitle || "grok-thread"}.json`, buildThreadExport(project, activeThread));
  }

  async function handleThemeChange(theme: FrontendTheme) {
    await saveTheme(theme);
    setSettings((current) => (current ? { ...current, theme } : current));
  }

  async function handleSaveApiKey() {
    if (!desktopRuntime) {
      return;
    }

    try {
      await saveApiKey(apiKeyDraft);
      const nextSettings = await loadSettings();
      setSettings(nextSettings);
      setApiKeyDraft("");
      setBanner("xAI API key saved to the Windows credential store.");
    } catch (error) {
      setBanner(formatCommandError(error));
    }
  }

  async function handleRemoveApiKey() {
    if (!desktopRuntime) {
      return;
    }

    try {
      await removeApiKey();
      const nextSettings = await loadSettings();
      setSettings(nextSettings);
      setApiKeyDraft("");
      setBanner("xAI API key removed from the Windows credential store.");
    } catch (error) {
      setBanner(formatCommandError(error));
    }
  }

  async function handleAttachFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.currentTarget.files;
    if (!fileList || fileList.length === 0) {
      return;
    }

    try {
      const nextAttachments = await filesToAttachments(fileList);
      setAttachments((current) => {
        const seen = new Set(current.map((attachment) => attachment.name));
        return [
          ...current,
          ...nextAttachments.filter((attachment) => !seen.has(attachment.name)),
        ];
      });
      event.currentTarget.value = "";
    } catch (error) {
      setBanner(formatCommandError(error));
    }
  }

  function openSettings() {
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
  }

  function handleResetWorkspace() {
    const project = createProject();
    const thread = createEmptyThread(project.id);
    setWorkspace({ projects: [project], threads: [thread] });
    setActiveProjectId(project.id);
    setActiveThreadId(thread.id);
    setConfirmWorkspaceReset(false);
    closeSettings();
  }

  async function handleAttachAction() {
    if (!desktopRuntime) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const nextAttachments = await pickDesktopAttachments();
      if (nextAttachments.length === 0) {
        return;
      }
      setAttachments((current) => {
        const seen = new Set(current.map((attachment) => attachment.path || attachment.name));
        return [
          ...current,
          ...nextAttachments.filter((attachment) => !seen.has(attachment.path || attachment.name)),
        ];
      });
    } catch (error) {
      setBanner(formatCommandError(error));
    }
  }

  async function sendDraft(draft: ComposerDraft) {
    if (!activeThread || pending) {
      return;
    }

    if (!settings?.apiKeyConfigured) {
      setBanner(
        desktopRuntime
          ? "xAI API key is missing. Save it in Settings before sending."
          : "GROK_API_KEY is missing. Add it to .env and restart the dev server.",
      );
      return;
    }

    const text = draft.text.trim();
    if (!text && draft.attachments.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const userMessageId = createId();
    const assistantMessageId = createId();
    const requestMode = draft.mode;
    const requestReasoning = requestMode === "standard" && draft.reasoningEnabled;
    const requestAgentDepth = requestMode === "agent" ? draft.agentDepth : null;
    const requestTools = [...draft.enabledTools];
    const requestModel = modelLabel(requestMode, requestReasoning, requestAgentDepth);
    const lastCompletedAssistant = [...activeThread.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "completed");
    const resettingContinuationForModeSwitch =
      activeThread.lastResponseId &&
      lastCompletedAssistant?.mode === "agent" &&
      requestMode === "standard";
    const requestPreviousResponseId = resettingContinuationForModeSwitch
      ? null
      : activeThread.lastResponseId;
    const historyMessages =
      !desktopRuntime && !requestPreviousResponseId ? buildHistoryMessages(activeThread.messages) : [];
    let targetAssistantMessageId = assistantMessageId;

    if (!desktopRuntime) {
      updateThread(activeThread.id, (thread) => ({
        ...thread,
        title: thread.title === "New chat" && text ? text.slice(0, 56) : thread.title,
        updatedAt: now,
        continuationLost: false,
        contextStatus: resettingContinuationForModeSwitch ? "fresh_context" : "normal",
        contextDetail: resettingContinuationForModeSwitch
          ? "Deep Research to Chat fallback starts a fresh model context for this turn."
          : null,
        messages: [
          ...thread.messages,
          {
            id: userMessageId,
            role: "user",
            text,
            createdAt: now,
            status: "completed",
            mode: requestMode,
            reasoningEnabled: requestReasoning,
            agentDepth: requestAgentDepth,
            selectedModelAlias: requestModel,
            enabledTools: requestTools,
            invokedTools: [],
            attachments: draft.attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              path: attachment.path || attachment.name,
              sizeBytes: attachment.sizeBytes,
            })),
            usage: null,
            error: null,
            requestId: null,
            responseId: null,
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: "",
            createdAt: now,
            status: "pending",
            mode: requestMode,
            reasoningEnabled: requestReasoning,
            agentDepth: requestAgentDepth,
            selectedModelAlias: requestModel,
            enabledTools: requestTools,
            invokedTools: [],
            attachments: [],
            usage: null,
            error: null,
            requestId: null,
            responseId: null,
          },
        ],
      }));

      refreshProjectTimestamp(activeThread.projectId);
    }
    setPending(true);
    setBanner(
      resettingContinuationForModeSwitch
        ? "Switching from Deep Research back to Chat starts a fresh model context for this turn because xAI rejected that continuation path."
        : null,
    );
    setComposerText("");
    setAttachments([]);
    if (!desktopRuntime) {
      setAgentEvents((current) => ({ ...current, [assistantMessageId]: [] }));
    }

    const controller = new AbortController();
    pendingRequestRef.current = controller;

    try {
      await streamChat(
        {
          text,
          mode: requestMode,
          reasoningEnabled: requestReasoning,
          agentDepth: draft.agentDepth,
          enabledTools: requestTools,
          previousResponseId: requestPreviousResponseId,
          historyMessages,
          attachments: draft.attachments,
          signal: controller.signal,
          debugScenario: desktopRuntime ? null : debugScenario === "off" ? null : debugScenario,
          threadId: desktopRuntime ? activeThread.id : undefined,
        },
        (event: ChatStreamEvent) => {
          updateThread(activeThread.id, (thread) => {
            const messages = thread.messages.map((message) => {
              if (message.id !== targetAssistantMessageId) {
                return message;
              }

              if (event.type === "delta") {
                return {
                  ...message,
                  status: "streaming" as const,
                  text: `${message.text}${event.delta}`,
                };
              }

              if (event.type === "tool") {
                const exists = message.invokedTools.some(
                  (entry) => entry.tool === event.tool && entry.status === event.status,
                );
                return {
                  ...message,
                  invokedTools: exists
                    ? message.invokedTools
                    : [
                        ...message.invokedTools,
                        {
                          tool: event.tool,
                          label: event.label,
                          status: event.status,
                        } satisfies ToolActivity,
                      ],
                };
              }

              if (event.type === "done") {
                return {
                  ...message,
                  status: "completed" as const,
                  text: event.message || message.text,
                  usage: event.usage,
                  responseId: event.responseId,
                  selectedModelAlias: event.modelAlias,
                };
              }

              return message;
            });

            if (event.type === "done") {
              return {
                ...thread,
                updatedAt: new Date().toISOString(),
                lastResponseId: event.responseId || thread.lastResponseId,
                continuationLost: false,
                contextStatus: resettingContinuationForModeSwitch ? "fresh_context" : "normal",
                contextDetail: resettingContinuationForModeSwitch
                  ? "This reply started from a fresh model context."
                  : "Server continuation is healthy for this thread.",
                messages,
              };
            }

            return {
              ...thread,
              updatedAt: new Date().toISOString(),
              messages,
            };
          });

          if (event.type === "agent") {
            setAgentEvents((current) => ({
              ...current,
              [targetAssistantMessageId]: [...(current[targetAssistantMessageId] ?? []), event.detail].slice(-4),
            }));
          } else if (event.type === "done" && requestMode === "agent") {
            setAgentEvents((current) => ({
              ...current,
              [targetAssistantMessageId]: ["Multi-agent research finished."],
            }));
          }
        },
        (nextWorkspace) => {
          if (!desktopRuntime) {
            return;
          }

          const refreshedThread = nextWorkspace.threads.find((thread) => thread.id === activeThread.id);
          const pendingAssistant = refreshedThread?.messages
            .slice()
            .reverse()
            .find(
              (message) =>
                message.role === "assistant" &&
                (message.status === "pending" || message.status === "streaming"),
            );
          if (pendingAssistant) {
            targetAssistantMessageId = pendingAssistant.id;
            setAgentEvents((current) => ({ ...current, [pendingAssistant.id]: [] }));
          }
          startTransition(() => {
            setWorkspace(nextWorkspace);
            setActiveProjectId(refreshedThread?.projectId || activeProjectId);
            setActiveThreadId(activeThread.id);
          });
        },
      );
      setServerReachable(true);
    } catch (error) {
      const errorCode = getCommandErrorCode(error);
      updateThread(activeThread.id, (thread) => ({
        ...thread,
        updatedAt: new Date().toISOString(),
        lastResponseId: errorCode === "invalid_previous_response_id" ? null : thread.lastResponseId,
        continuationLost:
          errorCode === "invalid_previous_response_id" ? true : thread.continuationLost,
        contextStatus: errorCode === "invalid_previous_response_id" ? "lost" : thread.contextStatus,
        contextDetail:
          errorCode === "invalid_previous_response_id"
            ? "Server-side continuation was rejected. The next send starts a fresh context."
            : thread.contextDetail,
        messages: thread.messages.map((message) => {
          if (message.id !== assistantMessageId) {
            return message;
          }
          if (errorCode === "aborted") {
            return {
              ...message,
              status: "cancelled" as const,
              error: null,
            };
          }
          return {
            ...message,
            status: "error" as const,
            error: formatCommandError(error),
          };
        }),
      }));

      if (errorCode !== "aborted") {
        setBanner(formatCommandError(error));
      }

      if (
        errorCode === null &&
        error instanceof Error &&
        (error.message.includes("Failed to fetch") || error.message.includes("Network"))
      ) {
        setServerReachable(false);
      }
    } finally {
      if (desktopRuntime) {
        void loadWorkspaceFromStorage()
          .then((nextWorkspace) => setWorkspace(nextWorkspace))
          .catch(() => {});
      }
      setPending(false);
      pendingRequestRef.current = null;
    }
  }

  async function handleSend() {
    await sendDraft({
      text: composerText,
      mode: composerMode,
      reasoningEnabled,
      agentDepth,
      enabledTools,
      attachments,
    });
  }

  function handleRetry(assistantMessageId: string) {
    if (!activeThread) {
      return;
    }

    const source = findRetrySource(activeThread.messages, assistantMessageId);
    if (!source) {
      return;
    }

    syncComposerWithMessage(source);

    if (source.attachments.length > 0) {
      setBanner("Retry loaded the original prompt settings. Reattach files before sending again.");
      composerRef.current?.focus();
      return;
    }

    void sendDraft({
      text: source.text,
      mode: source.mode,
      reasoningEnabled: source.reasoningEnabled,
      agentDepth: source.agentDepth || "4",
      enabledTools: source.enabledTools,
      attachments: [],
    });
  }

  function handleStop() {
    pendingRequestRef.current?.abort();
  }

  function handleStarterPrompt(prompt: string) {
    setComposerText(prompt);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  const canSend =
    Boolean(activeThread) && !pending && (composerText.trim().length > 0 || attachments.length > 0);
  const showContextStrip =
    !serverReachable ||
    activeThread?.contextStatus === "fresh_context" ||
    activeThread?.contextStatus === "lost";
  const settingsTitleId = "settings-modal-title";
  const settingsDescriptionId = "settings-modal-description";
  const threadUsage = useMemo(
    () => (activeThread ? sumThreadUsage(activeThread.messages) : null),
    [activeThread],
  );

  if (loading) {
    return (
      <main className="loading-shell">
        <div className="loading-card">
          <p className="eyebrow">Grok Control</p>
          <h1>Preparing workspace</h1>
          <p>Loading your chats, settings, and workspace.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="web-shell">
      <section className="app-shell">
      <aside className="thread-sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">G</div>
          <span className="sidebar-brand-label">Grok Control</span>
        </div>

        <div className="sidebar-actions">
          <button className="nav-button is-primary" onClick={() => handleNewThread()} type="button">
            New chat
          </button>
        </div>

        <label className="search-card">
          <span className="eyebrow">Search threads</span>
          <input
            onChange={(event) => setThreadQuery(event.currentTarget.value)}
            placeholder="Find a thread"
            value={threadQuery}
          />
        </label>

        <div className="sidebar-section is-fill">
          <div className="thread-section-header">
            <p className="eyebrow">Threads</p>
            <span>{visibleThreads.length}</span>
          </div>
          <div className="thread-list">
            {visibleThreads.length > 0 ? (
              visibleThreads.map((thread) => (
                <button
                  className={`thread-card ${activeThreadId === thread.id ? "is-active" : ""}`}
                  key={thread.id}
                  onClick={() => {
                    setActiveThreadId(thread.id);
                    setActiveProjectId(thread.projectId);
                  }}
                  type="button"
                >
                  <div className="thread-card-main">
                    <strong className="thread-card-title">{thread.title}</strong>
                  </div>
                  <span className="thread-card-time">{formatTimestamp(thread.updatedAt)}</span>
                </button>
              ))
            ) : (
              <div className="empty-sidebar-card">
                <strong>No chats yet</strong>
                <p>Start a new chat or use search to reopen an older one.</p>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <button
            className="sidebar-footer-button"
            onClick={openSettings}
            ref={settingsTriggerRef}
            type="button"
          >
            <span className="footer-icon">⚙</span>
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <section className="conversation-pane">
        <header className="topbar">
          <div className="topbar-copy">
            <h2>{activeThread?.title || "Select a thread"}</h2>
            <p className="topbar-note">
              {activeThread?.messages.length
                ? activeThread?.contextStatus === "lost"
                  ? "This conversation lost its place. The next reply will rebuild context from local history."
                  : activeThread?.contextStatus === "fresh_context"
                    ? "This conversation restarted from a fresh context and will keep building from here."
                    : ""
                : ""}
            </p>
          </div>
          <div className="topbar-actions">
            {!serverReachable ? (
              <button
                className="text-button is-warning"
                onClick={() => {
                  void loadSettings()
                    .then((nextSettings) => {
                      setSettings(nextSettings);
                      setServerReachable(true);
                      setBanner(null);
                    })
                    .catch((error) => setBanner(formatCommandError(error)));
                }}
                type="button"
              >
                Retry connection
              </button>
            ) : null}
            <button className="text-button" onClick={handleExportThread} type="button">
              Export
            </button>
            <button
              className="text-button"
              onClick={() => activeThread && handleDeleteThread(activeThread.id)}
              type="button"
            >
              Delete
            </button>
          </div>
        </header>

        {banner ? <div className="banner">{banner}</div> : null}
        {!settings?.apiKeyConfigured ? (
          <div className="banner is-warning">
            {desktopRuntime
              ? "The desktop app cannot call Grok until an xAI API key is saved in Settings."
              : "The site cannot call Grok until `GROK_API_KEY` is present in `.env` and the local server is restarted."}
          </div>
        ) : null}
        {showContextStrip ? (
          <div className={`context-strip is-${activeThread?.contextStatus || "normal"}`}>
            <div>
              <span className="eyebrow">Context status</span>
              <strong>
                {!serverReachable && !desktopRuntime
                  ? "Local proxy unavailable"
                  : contextLabel(activeThread?.contextStatus)}
              </strong>
              <p>
                {!serverReachable && !desktopRuntime
                  ? "The website cannot reach the local Grok server right now."
                  : activeThread?.contextDetail ||
                    "Follow-up turns reuse the latest valid server continuation when xAI accepts it."}
              </p>
            </div>
          </div>
        ) : null}

        <div className="transcript" ref={transcriptRef}>
          {activeThread ? (
            activeThread.messages.length === 0 ? (
              <div className="empty-thread-shell">
                <p className="eyebrow">Start here</p>
                <h3>A focused workspace for asking, exploring, and solving with Grok.</h3>
                <p>Start with something immediate, then refine it turn by turn.</p>
                <div className="starter-grid">
                  {STARTER_PROMPTS.map((entry) => (
                    <button
                      className="starter-card"
                      key={entry.title}
                      onClick={() => handleStarterPrompt(entry.prompt)}
                      type="button"
                    >
                      <strong>{entry.title}</strong>
                      <span>{entry.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : activeThread.messages.map((message) => {
              const currentAgentEvents = agentEvents[message.id] ?? [];
              return (
                <article
                  className={`message-card ${message.role === "user" ? "is-user" : "is-assistant"}`}
                  key={message.id}
                >
                  <div className="message-meta-row">
                    <div className="message-meta-main">
                      <div className="message-header">
                        <div>
                          <span className="message-role">{message.role === "user" ? "You" : "Grok"}</span>
                          <span className="message-time">{formatTimestamp(message.createdAt)}</span>
                        </div>
                        <div className="message-flags">
                          <span className="badge">
                            {modelLabel(message.mode, message.reasoningEnabled, message.agentDepth)}
                          </span>
                          {message.mode === "agent" ? (
                            <span className="badge">{modeDisplayLabel(message.mode)}</span>
                          ) : null}
                          {message.reasoningEnabled && message.mode === "standard" ? (
                            <span className="badge">Reasoning on</span>
                          ) : null}
                          {message.enabledTools.map((tool) => (
                            <span className="badge" key={`${message.id}-${tool}`}>
                              {TOOL_OPTIONS.find((option) => option.id === tool)?.label || tool}
                            </span>
                          ))}
                          {message.role === "assistant" &&
                          (message.status === "completed" || message.status === "error") ? (
                            <button className="text-button" onClick={() => handleRetry(message.id)} type="button">
                              Retry
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>

                {message.attachments.length > 0 ? (
                  <div className="attachment-row">
                    {message.attachments.map((attachment) => (
                      <span className="attachment-chip" key={attachment.id}>
                        {attachment.name}
                      </span>
                    ))}
                  </div>
                ) : null}

                {message.role === "assistant" ? (
                  <div className="markdown-body">
                    {message.text ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code({ className, children, ...props }) {
                            const text = String(children).replace(/\n$/, "");
                            const isInline = !className && !text.includes("\n");
                            if (isInline) {
                              return (
                                <code className={className} {...props}>
                                  {children}
                                </code>
                              );
                            }

                            return (
                              <div className="code-block">
                                <button
                                  className="copy-button"
                                  onClick={() => void navigator.clipboard.writeText(text)}
                                  type="button"
                                >
                                  Copy
                                </button>
                                <pre>
                                  <code className={className}>{text}</code>
                                </pre>
                              </div>
                            );
                          },
                        }}
                      >
                        {message.text}
                      </ReactMarkdown>
                    ) : (
                      <p className="placeholder-copy">Waiting for Grok.</p>
                    )}
                    {message.status === "streaming" ? <span className="streaming-caret" aria-hidden="true" /> : null}
                  </div>
                ) : (
                  <div className="plain-copy">{message.text}</div>
                )}

                {message.invokedTools.length > 0 ? (
                  <div className="tool-trace">
                    {message.invokedTools.map((tool, index) => (
                      <div className="trace-row" key={`${tool.tool}-${tool.status}-${index}`}>
                        <span>{tool.label}</span>
                        <strong>{tool.status}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}

                {currentAgentEvents.length > 0 ? (
                  <div className="tool-trace">
                    {currentAgentEvents.map((detail, index) => (
                      <div className="trace-row" key={`${message.id}-agent-${index}`}>
                        <span>Agent</span>
                        <strong>{detail}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}

                {statusLabel(message, currentAgentEvents) ? (
                  <p className="status-copy">{statusLabel(message, currentAgentEvents)}</p>
                ) : null}
                {message.error ? <p className="error-copy">{message.error}</p> : null}
                </article>
              );
            })
          ) : (
            <div className="empty-thread-shell">
              <p className="eyebrow">No chat selected</p>
              <h3>Pick a chat to continue</h3>
              <p>Start a new chat from the sidebar to begin a Grok conversation.</p>
              <button className="primary-button" onClick={() => handleNewThread()} type="button">
                Start new chat
              </button>
            </div>
          )}
        </div>

        <footer className="composer-shell">
          <div className="composer-topbar">
            <div className="composer-heading">
              <div className="mode-row">
                <button
                  className={`pill ${composerMode === "standard" ? "is-on" : ""}`}
                  onClick={() => setComposerMode("standard")}
                  type="button"
                >
                  {modeDisplayLabel("standard")}
                </button>
                <button
                  className={`pill ${composerMode === "agent" ? "is-on" : ""}`}
                  onClick={() => setComposerMode("agent")}
                  type="button"
                >
                  {modeDisplayLabel("agent")}
                </button>
              </div>
            </div>
            {threadUsage ? (
              <div className="composer-usage-inline">
                <span className="usage-inline-item">
                  <span>Input</span>
                  <strong>{threadUsage.inputTokens.toLocaleString()} tok</strong>
                  <small>{formatCurrency(threadUsage.estimatedCosts.inputUsd)}</small>
                </span>
                <span className="usage-inline-item">
                  <span>Output</span>
                  <strong>{threadUsage.outputTokens.toLocaleString()} tok</strong>
                  <small>{formatCurrency(threadUsage.estimatedCosts.outputUsd)}</small>
                </span>
                <span className="usage-inline-item">
                  <span>Reasoning</span>
                  <strong>{threadUsage.reasoningTokens.toLocaleString()} tok</strong>
                  <small>{formatCurrency(threadUsage.estimatedCosts.reasoningUsd)}</small>
                </span>
                <span className="usage-inline-item">
                  <span>Cached input</span>
                  <strong>{threadUsage.cachedInputTokens.toLocaleString()} tok</strong>
                  <small>{formatCurrency(threadUsage.estimatedCosts.cachedInputUsd)}</small>
                </span>
                <span className="usage-inline-item">
                  <span>Tools</span>
                  <strong>{threadUsage.toolCalls.reduce((sum, entry) => sum + entry.count, 0)} calls</strong>
                  <small>{formatCurrency(threadUsage.estimatedCosts.toolsUsd)}</small>
                </span>
                <span className="usage-inline-item is-total">
                  <span>Thread total</span>
                  <strong>{formatCurrency(threadUsage.estimatedCosts.totalUsd)}</strong>
                  <small>
                    {threadUsage.billedTotalUsd
                      ? `Billed ${formatCurrency(threadUsage.billedTotalUsd)}`
                      : "Estimate only"}
                  </small>
                </span>
              </div>
            ) : (
              <span className="mode-description">
                {composerMode === "agent"
                  ? "Deeper multi-agent work with the same tools."
                  : "Fast Grok chat with optional tools."}
              </span>
            )}
          </div>

          <div className="controls-row">
            {composerMode === "standard" ? (
              <button
                className={`pill ${reasoningEnabled ? "is-on" : ""}`}
                onClick={() => setReasoningEnabled((current) => !current)}
                type="button"
              >
                Reasoning
              </button>
            ) : (
              <div className="tool-toggle-group">
                <button
                  className={`pill ${agentDepth === "4" ? "is-on" : ""}`}
                  onClick={() => setAgentDepth("4")}
                  type="button"
                >
                  Quick · 4 agents
                </button>
                <button
                  className={`pill ${agentDepth === "16" ? "is-on" : ""}`}
                  onClick={() => setAgentDepth("16")}
                  type="button"
                >
                  Deep · 16 agents
                </button>
              </div>
            )}
            <div className="tool-toggle-group">
              {TOOL_OPTIONS.map((tool) => (
                <button
                  className={`pill ${enabledTools.includes(tool.id) ? "is-on" : ""}`}
                  key={tool.id}
                  onClick={() =>
                    setEnabledTools((current) =>
                      current.includes(tool.id)
                        ? current.filter((entry) => entry !== tool.id)
                        : [...current, tool.id],
                    )
                  }
                  type="button"
                >
                  {tool.label}
                </button>
              ))}
            </div>
          </div>

          <div className="composer-card">
            <textarea
              onChange={(event) => setComposerText(event.currentTarget.value)}
              placeholder={
                composerMode === "agent"
                  ? "Investigate, compare, or work through something deeply."
                  : "Ask Grok anything."
              }
              rows={1}
              ref={composerRef}
              value={composerText}
            />

            {attachments.length > 0 ? (
              <div className="attachment-row composer-inline-row">
                {attachments.map((attachment) => (
                  <button
                    className="attachment-chip"
                    key={attachment.id}
                    onClick={() =>
                      setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
                    }
                    type="button"
                  >
                    {attachment.name}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="composer-card-footer">
              <div className="footer-meta">
                <span className="badge is-muted">
                  {modelLabel(
                    composerMode,
                    composerMode === "standard" && reasoningEnabled,
                    composerMode === "agent" ? agentDepth : null,
                  )}
                </span>
                <span className="badge is-muted">
                  {enabledTools.length > 0
                    ? `Tools ${enabledTools
                        .map((tool) => TOOL_OPTIONS.find((entry) => entry.id === tool)?.label || tool)
                        .join(" + ")}`
                    : "No tools"}
                </span>
                <span className="badge is-muted">Send {shortcutLabel("Ctrl+Enter")}</span>
              </div>
              <div className="action-group">
                <input
                  accept=".txt,.md,.py,.rs,.ts,.tsx,.js,.jsx,.json,.yaml,.yml,.toml,.csv,.html,.css,.sql,.java,.cpp,.c,.h,.hpp,.go,.swift,.kt,.sh,.ps1,.xml"
                  hidden
                  multiple
                  onChange={handleAttachFiles}
                  ref={fileInputRef}
                  type="file"
                />
                <button
                  className="secondary-button"
                  onClick={() => void handleAttachAction()}
                  type="button"
                >
                  Attach files
                </button>
                {pending ? (
                  <button className="secondary-button danger-button" onClick={handleStop} type="button">
                    Stop
                  </button>
                ) : (
                  <button className="primary-button" disabled={!canSend} onClick={() => void handleSend()} type="button">
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </footer>
      </section>

      {settingsOpen && settings ? (
        <div className="modal-backdrop" onClick={closeSettings} role="presentation">
          <section
            aria-describedby={settingsDescriptionId}
            aria-labelledby={settingsTitleId}
            aria-modal="true"
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
            ref={settingsDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="settings-header">
              <div>
                <p className="eyebrow">Settings</p>
                <h3 id={settingsTitleId}>Settings</h3>
              </div>
              <button className="text-button" onClick={closeSettings} type="button">
                Close
              </button>
            </div>
            <p className="settings-note settings-intro" id={settingsDescriptionId}>
              Keep account access, appearance, and local workspace controls in one place.
            </p>

            <div className="settings-group">
              <p className="settings-section-title">API access</p>
              <p className="settings-note">
                {desktopRuntime ? (
                  <>
                    API access is stored in the Windows credential store. Current status:{" "}
                    <strong>{settings.apiKeyConfigured ? "configured" : "missing"}</strong>.
                  </>
                ) : (
                  <>
                    API access is read from the website environment. Current status:{" "}
                    <strong>{settings.apiKeyConfigured ? "configured" : "missing"}</strong>.
                  </>
                )}
              </p>
              <p className="settings-note">
                Chats stay local to this device so you can come back to them later.
              </p>
            </div>

            {desktopRuntime ? (
              <div className="settings-group">
                <label>
                  <span>xAI API key</span>
                  <input
                    onChange={(event) => setApiKeyDraft(event.currentTarget.value)}
                    placeholder="xai-..."
                    type="password"
                    value={apiKeyDraft}
                  />
                </label>
                <button
                  className="secondary-button"
                  disabled={!apiKeyDraft.trim()}
                  onClick={() => void handleSaveApiKey()}
                  type="button"
                >
                  Save key
                </button>
                <button
                  className="text-button"
                  disabled={!settings.apiKeyConfigured}
                  onClick={() => void handleRemoveApiKey()}
                  type="button"
                >
                  Remove saved key
                </button>
              </div>
            ) : null}

            <div className="settings-group">
              <p className="settings-section-title">Theme</p>
              <label>
                <span>Theme</span>
                <select
                  onChange={(event) => void handleThemeChange(event.currentTarget.value as FrontendTheme)}
                  value={settings.theme}
                >
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
            </div>

            {!desktopRuntime ? (
              <div className="settings-group">
                <p className="settings-section-title">Advanced diagnostics</p>
                <label>
                  <span>Failure testing</span>
                  <select
                    onChange={(event) => setDebugScenario(event.currentTarget.value as DebugScenarioId)}
                    value={debugScenario}
                  >
                    {DEBUG_SCENARIOS.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="settings-note">
                  Use local failure modes to check reconnect, retry, and recovery behavior without waiting for live incidents.
                </p>
              </div>
            ) : (
              <div className="settings-group">
                <p className="settings-section-title">Advanced diagnostics</p>
                <p className="settings-note">
                  Desktop debug harness parity is still pending. Use the web debug surface when you need simulated upstream failures.
                </p>
              </div>
            )}

            <div className="settings-group">
              <p className="settings-section-title">Known limitations</p>
              <p className="settings-note">
                Some X-based prompts, especially in Deep Research, can still be blocked upstream by xAI policy.
              </p>
            </div>

            <div className="settings-group settings-danger-zone">
              <p className="settings-section-title">Danger zone</p>
              <p className="settings-note">
                Resetting the local workspace removes chats saved on this machine.
              </p>
              {confirmWorkspaceReset ? (
                <div className="danger-actions">
                  <button className="secondary-button" onClick={() => setConfirmWorkspaceReset(false)} type="button">
                    Cancel
                  </button>
                  <button className="secondary-button danger-button" onClick={handleResetWorkspace} type="button">
                    Confirm reset
                  </button>
                </div>
              ) : (
                <button
                  className="secondary-button danger-button"
                  onClick={() => setConfirmWorkspaceReset(true)}
                  type="button"
                >
                  Clear local workspace
                </button>
              )}
            </div>

            <div className="settings-group">
              <p className="settings-section-title">Shortcuts</p>
              <p className="settings-note">Keyboard shortcuts</p>
              <div className="shortcut-list">
                <div className="shortcut-row">
                  <span>Send message</span>
                  <kbd>{shortcutLabel("Ctrl+Enter")}</kbd>
                </div>
                <div className="shortcut-row">
                  <span>New chat</span>
                  <kbd>{shortcutLabel("Ctrl+N")}</kbd>
                </div>
                <div className="shortcut-row">
                  <span>Open settings</span>
                  <kbd>{shortcutLabel("Ctrl+,")}</kbd>
                </div>
                <div className="shortcut-row">
                  <span>Toggle deep research</span>
                  <kbd>{shortcutLabel("Ctrl+Shift+A")}</kbd>
                </div>
                <div className="shortcut-row">
                  <span>Toggle reasoning</span>
                  <kbd>{shortcutLabel("Ctrl+Shift+R")}</kbd>
                </div>
                <div className="shortcut-row">
                  <span>Focus composer</span>
                  <kbd>{shortcutLabel("Ctrl+L")}</kbd>
                </div>
                <div className="shortcut-row">
                  <span>Close settings or banner</span>
                  <kbd>Esc</kbd>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      </section>
    </main>
  );
}

export default App;
