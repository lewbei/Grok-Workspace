export type ChatMode = "standard" | "agent";
export type MessageRole = "user" | "assistant";
export type MessageStatus = "pending" | "streaming" | "completed" | "cancelled" | "error";
export type FrontendTheme = "system" | "dark" | "light";
export type FrontendToolName = "web_search" | "x_search" | "code_interpreter";
export type AgentDepth = "4" | "16";
export type ThreadContextStatus = "normal" | "fresh_context" | "lost";

export interface AppSettings {
  ok?: boolean;
  apiKeyConfigured: boolean;
  pricingConfigVersion: string;
  theme: FrontendTheme;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  projects: ProjectRecord[];
  threads: ThreadRecord[];
}

export interface ThreadSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  lastMessagePreview?: string | null;
  pinned?: boolean;
}

export interface AttachmentRecord {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
}

export interface BrowserAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  content?: string;
  path?: string;
}

export interface ToolActivity {
  tool: FrontendToolName;
  label: string;
  status: string;
}

export interface ToolCallUsage {
  tool: FrontendToolName;
  count: number;
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  reasoningUsd: number;
  cachedInputUsd: number;
  toolsUsd: number;
  totalUsd: number;
}

export interface ResponseUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  toolCalls: ToolCallUsage[];
  estimatedCosts: CostBreakdown;
  billedTotalUsd?: number | null;
}

export interface MessageRecord {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  status: MessageStatus;
  mode: ChatMode;
  reasoningEnabled: boolean;
  agentDepth?: AgentDepth | null;
  selectedModelAlias?: string | null;
  enabledTools: FrontendToolName[];
  invokedTools: ToolActivity[];
  attachments: AttachmentRecord[];
  usage?: ResponseUsage | null;
  error?: string | null;
  requestId?: string | null;
  responseId?: string | null;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastResponseId?: string | null;
  continuationLost?: boolean;
  contextStatus?: ThreadContextStatus;
  contextDetail?: string | null;
  messages: MessageRecord[];
}
