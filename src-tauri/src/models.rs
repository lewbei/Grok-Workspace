use serde::{Deserialize, Serialize};

use crate::pricing::CostBreakdown;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatMode {
    Standard,
    Agent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Pending,
    Streaming,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrontendTheme {
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FrontendToolName {
    WebSearch,
    XSearch,
    CodeInterpreter,
}

impl FrontendToolName {
    pub fn api_name(self) -> &'static str {
        match self {
            Self::WebSearch => "web_search",
            Self::XSearch => "x_search",
            Self::CodeInterpreter => "code_interpreter",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::WebSearch => "Web",
            Self::XSearch => "X",
            Self::CodeInterpreter => "Code",
        }
    }

    pub fn from_event_type(value: &str) -> Option<Self> {
        let lower = value.to_ascii_lowercase();
        if lower.contains("web_search") || lower.contains("websearch") {
            Some(Self::WebSearch)
        } else if lower.contains("x_search")
            || lower.contains("\"x\"")
            || lower.contains("xsearch")
            || lower.contains("x_keyword_search")
            || lower.contains("\"xs_")
        {
            Some(Self::XSearch)
        } else if lower.contains("code_interpreter")
            || lower.contains("code_execution")
            || lower.contains("codeinterpreter")
        {
            Some(Self::CodeInterpreter)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentDepth {
    #[serde(rename = "4")]
    Quick,
    #[serde(rename = "16")]
    Deep,
}

impl AgentDepth {
    pub fn count(self) -> u8 {
        match self {
            Self::Quick => 4,
            Self::Deep => 16,
        }
    }

    pub fn effort(self) -> &'static str {
        match self {
            Self::Quick => "low",
            Self::Deep => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadContextStatus {
    Normal,
    FreshContext,
    Lost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsResponse {
    pub api_key_configured: bool,
    pub pricing_config_version: String,
    pub theme: FrontendTheme,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveApiKeyArgs {
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveThemeArgs {
    pub theme: FrontendTheme,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceArgs {
    pub workspace: WorkspaceRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadArgs {
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadThreadArgs {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThreadArgs {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequestArgs {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeAttachmentsArgs {
    pub attachment_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageArgs {
    pub thread_id: String,
    pub text: String,
    pub attachment_paths: Vec<String>,
    pub mode: ChatMode,
    pub reasoning_enabled: Option<bool>,
    pub agent_depth: Option<AgentDepth>,
    pub enabled_tools: Option<Vec<FrontendToolName>>,
    pub debug_scenario: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResponse {
    pub request_id: String,
    pub workspace: WorkspaceRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadResponse {
    pub thread: ThreadRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAllThreadsResponse {
    pub deleted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub projects: Vec<ProjectRecord>,
    pub threads: Vec<ThreadRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub updated_at: String,
    pub last_message_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_response_id: Option<String>,
    pub continuation_lost: bool,
    pub context_status: ThreadContextStatus,
    pub context_detail: Option<String>,
    pub messages: Vec<MessageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub created_at: String,
    pub status: MessageStatus,
    pub mode: ChatMode,
    pub reasoning_enabled: bool,
    pub agent_depth: Option<AgentDepth>,
    pub selected_model_alias: Option<String>,
    pub enabled_tools: Vec<FrontendToolName>,
    pub invoked_tools: Vec<ToolActivity>,
    pub attachments: Vec<AttachmentRecord>,
    pub usage: Option<ResponseUsage>,
    pub error: Option<String>,
    pub request_id: Option<String>,
    pub response_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub tool: FrontendToolName,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallUsage {
    pub tool: FrontendToolName,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_input_tokens: u64,
    pub tool_calls: Vec<ToolCallUsage>,
    pub estimated_costs: CostBreakdown,
    pub billed_total_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDeltaPayload {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolPayload {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub tool: FrontendToolName,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub phase: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsagePayload {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub usage: ResponseUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDonePayload {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub cancelled: bool,
    pub message: Option<String>,
    pub response_id: Option<String>,
    pub model_alias: Option<String>,
    pub usage: Option<ResponseUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatErrorPayload {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub code: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct PendingRequestPlan {
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub model_alias: String,
    pub user_text: String,
    pub mode: ChatMode,
    pub agent_depth: Option<AgentDepth>,
    pub enabled_tools: Vec<FrontendToolName>,
    pub attachments: Vec<AttachmentRecord>,
    pub previous_response_id: Option<String>,
}
