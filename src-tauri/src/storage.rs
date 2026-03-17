use std::{ffi::OsStr, path::PathBuf};

use anyhow::{bail, Context};
use chrono::Utc;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::fs;
use uuid::Uuid;

use crate::{
    models::{
        AgentDepth, AppSettingsResponse, AttachmentRecord, ChatMode, FrontendTheme, MessageRecord,
        MessageRole, MessageStatus, PendingRequestPlan, ProjectRecord, ResponseUsage,
        SaveWorkspaceArgs, SendMessageArgs, ThreadContextStatus, ThreadRecord, ThreadSummary,
        ToolActivity, WorkspaceRecord,
    },
    pricing::PRICING_CONFIG_VERSION,
};

const SERVICE_NAME: &str = "com.lewka.grok.desktop";
const ACCOUNT_NAME: &str = "xai_api_key";
const DEFAULT_THREAD_TITLE: &str = "New chat";
const DEFAULT_PROJECT_NAME: &str = "Grok";

#[derive(Debug, Serialize, Deserialize)]
struct SettingsFile {
    theme: FrontendTheme,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyThreadRecord {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    last_response_id: Option<String>,
    messages: Vec<MessageRecord>,
}

pub enum ThreadPatch {
    Success {
        text: String,
        response_id: Option<String>,
        invoked_tools: Vec<ToolActivity>,
        usage: Option<ResponseUsage>,
    },
    Error {
        text: String,
        error: String,
        cancelled: bool,
    },
}

#[derive(Clone)]
pub struct Storage {
    base_dir: PathBuf,
    threads_dir: PathBuf,
    settings_path: PathBuf,
    workspace_path: PathBuf,
}

impl Storage {
    pub fn new(app: &tauri::AppHandle) -> anyhow::Result<Self> {
        let base_dir = app
            .path()
            .app_data_dir()
            .context("Unable to resolve the application data directory.")?
            .join("state");
        let threads_dir = base_dir.join("threads");
        let settings_path = base_dir.join("settings.json");
        let workspace_path = base_dir.join("workspace.json");

        Ok(Self {
            base_dir,
            threads_dir,
            settings_path,
            workspace_path,
        })
    }

    pub fn ensure_layout(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.base_dir)
            .with_context(|| format!("Failed to create {}", self.base_dir.display()))?;
        std::fs::create_dir_all(&self.threads_dir)
            .with_context(|| format!("Failed to create {}", self.threads_dir.display()))?;

        if !self.settings_path.exists() {
            let settings = SettingsFile {
                theme: FrontendTheme::System,
            };
            std::fs::write(&self.settings_path, serde_json::to_vec_pretty(&settings)?)
                .with_context(|| format!("Failed to create {}", self.settings_path.display()))?;
        }

        if !self.workspace_path.exists() {
            let workspace = self
                .load_legacy_workspace()
                .unwrap_or_else(|_| Self::default_workspace());
            std::fs::write(&self.workspace_path, serde_json::to_vec_pretty(&workspace)?)
                .with_context(|| format!("Failed to create {}", self.workspace_path.display()))?;
        }

        Ok(())
    }

    pub async fn load_settings(&self) -> anyhow::Result<AppSettingsResponse> {
        self.ensure_layout()?;
        let file = self.load_settings_file().await?;
        let api_key_configured = self.load_api_key().is_some();

        Ok(AppSettingsResponse {
            api_key_configured,
            pricing_config_version: PRICING_CONFIG_VERSION.to_string(),
            theme: file.theme,
        })
    }

    pub async fn save_theme(&self, theme: FrontendTheme) -> anyhow::Result<()> {
        self.ensure_layout()?;
        let file = SettingsFile { theme };
        fs::write(&self.settings_path, serde_json::to_vec_pretty(&file)?)
            .await
            .with_context(|| format!("Failed to write {}", self.settings_path.display()))?;
        Ok(())
    }

    pub fn save_api_key(&self, api_key: &str) -> anyhow::Result<()> {
        if api_key.trim().is_empty() {
            bail!("The API key cannot be empty.");
        }

        Entry::new(SERVICE_NAME, ACCOUNT_NAME)?
            .set_password(api_key)
            .context("Failed to save the API key to the operating system keychain.")?;

        Ok(())
    }

    pub fn remove_api_key(&self) -> anyhow::Result<()> {
        Entry::new(SERVICE_NAME, ACCOUNT_NAME)?
            .delete_credential()
            .context("Failed to remove the API key from the operating system keychain.")?;

        Ok(())
    }

    pub fn load_api_key(&self) -> Option<String> {
        let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).ok()?;
        entry.get_password().ok()
    }

    pub async fn load_workspace(&self) -> anyhow::Result<WorkspaceRecord> {
        self.ensure_layout()?;
        let mut workspace = self.read_workspace().await?;
        self.normalize_workspace(&mut workspace);
        Ok(workspace)
    }

    pub async fn save_workspace(&self, args: SaveWorkspaceArgs) -> anyhow::Result<WorkspaceRecord> {
        self.ensure_layout()?;
        let mut workspace = args.workspace;
        self.normalize_workspace(&mut workspace);
        self.write_workspace(&workspace).await?;
        Ok(workspace)
    }

    pub async fn list_threads(&self) -> anyhow::Result<Vec<ThreadSummary>> {
        let workspace = self.load_workspace().await?;
        let mut threads = workspace
            .threads
            .into_iter()
            .map(|thread| ThreadSummary {
                id: thread.id,
                project_id: thread.project_id,
                title: thread.title,
                updated_at: thread.updated_at,
                last_message_preview: thread
                    .messages
                    .iter()
                    .rev()
                    .find(|message| !message.text.trim().is_empty())
                    .map(|message| truncate(&message.text, 110)),
            })
            .collect::<Vec<_>>();

        threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(threads)
    }

    pub async fn create_thread(&self, title: Option<String>) -> anyhow::Result<ThreadRecord> {
        let mut workspace = self.load_workspace().await?;
        let project_id = workspace
            .projects
            .first()
            .map(|project| project.id.clone())
            .unwrap_or_else(|| {
                let project = Self::default_project();
                let id = project.id.clone();
                workspace.projects.push(project);
                id
            });
        let thread = Self::new_thread(project_id, title);
        workspace.threads.push(thread.clone());
        self.write_workspace(&workspace).await?;
        Ok(thread)
    }

    pub async fn load_thread(&self, thread_id: &str) -> anyhow::Result<ThreadRecord> {
        let workspace = self.load_workspace().await?;
        workspace
            .threads
            .into_iter()
            .find(|thread| thread.id == thread_id)
            .with_context(|| format!("Thread {thread_id} not found."))
    }

    pub async fn delete_thread(&self, thread_id: &str) -> anyhow::Result<()> {
        let mut workspace = self.load_workspace().await?;
        workspace.threads.retain(|thread| thread.id != thread_id);
        self.write_workspace(&workspace).await
    }

    pub async fn clear_all_threads(&self) -> anyhow::Result<usize> {
        let mut workspace = self.load_workspace().await?;
        let deleted = workspace.threads.len();
        workspace.threads.clear();
        self.write_workspace(&workspace).await?;
        Ok(deleted)
    }

    pub async fn describe_attachment_paths(
        &self,
        paths: &[String],
    ) -> anyhow::Result<Vec<AttachmentRecord>> {
        self.collect_attachments(paths).await
    }

    pub async fn prepare_outgoing_request(
        &self,
        args: &SendMessageArgs,
    ) -> anyhow::Result<PendingRequestPlan> {
        self.ensure_layout()?;

        let text = args.text.trim().to_string();
        let attachments = self.collect_attachments(&args.attachment_paths).await?;
        if text.is_empty() && attachments.is_empty() {
            bail!("Enter a prompt or attach at least one text/code file.");
        }

        let mut workspace = self.read_workspace().await?;
        let thread = workspace
            .threads
            .iter_mut()
            .find(|thread| thread.id == args.thread_id)
            .with_context(|| format!("Thread {} not found.", args.thread_id))?;

        let request_id = Uuid::new_v4().to_string();
        let user_message_id = Uuid::new_v4().to_string();
        let assistant_message_id = Uuid::new_v4().to_string();
        let reasoning_enabled = matches!(args.mode, ChatMode::Standard)
            && args.reasoning_enabled.unwrap_or(false);
        let agent_depth = if matches!(args.mode, ChatMode::Agent) {
            Some(args.agent_depth.unwrap_or(AgentDepth::Quick))
        } else {
            None
        };
        let enabled_tools = args.enabled_tools.clone().unwrap_or_default();
        let model_alias = resolve_model_alias(args.mode, reasoning_enabled);
        let now = now_string();

        let last_completed_assistant = thread
            .messages
            .iter()
            .rev()
            .find(|message| {
                matches!(message.role, MessageRole::Assistant)
                    && matches!(message.status, MessageStatus::Completed)
            });
        let resetting_continuation = thread.last_response_id.is_some()
            && matches!(last_completed_assistant.map(|message| message.mode), Some(ChatMode::Agent))
            && matches!(args.mode, ChatMode::Standard);
        let previous_response_id = if resetting_continuation {
            None
        } else {
            thread.last_response_id.clone()
        };

        let user_message = MessageRecord {
            id: user_message_id,
            role: MessageRole::User,
            text: text.clone(),
            created_at: now.clone(),
            status: MessageStatus::Completed,
            mode: args.mode,
            reasoning_enabled,
            agent_depth,
            selected_model_alias: Some(model_alias.to_string()),
            enabled_tools: enabled_tools.clone(),
            invoked_tools: Vec::new(),
            attachments: attachments.clone(),
            usage: None,
            error: None,
            request_id: Some(request_id.clone()),
            response_id: None,
        };

        let assistant_message = MessageRecord {
            id: assistant_message_id.clone(),
            role: MessageRole::Assistant,
            text: String::new(),
            created_at: now.clone(),
            status: MessageStatus::Pending,
            mode: args.mode,
            reasoning_enabled,
            agent_depth,
            selected_model_alias: Some(model_alias.to_string()),
            enabled_tools: enabled_tools.clone(),
            invoked_tools: Vec::new(),
            attachments: Vec::new(),
            usage: None,
            error: None,
            request_id: Some(request_id.clone()),
            response_id: None,
        };

        thread.messages.push(user_message);
        thread.messages.push(assistant_message);
        if thread.title == DEFAULT_THREAD_TITLE && !text.is_empty() {
            thread.title = build_thread_title(&text);
        }
        thread.updated_at = now;
        thread.continuation_lost = false;
        if resetting_continuation {
            thread.context_status = ThreadContextStatus::FreshContext;
            thread.context_detail =
                Some("Agent to Standard fallback starts a fresh model context for this turn.".into());
        } else {
            thread.context_status = ThreadContextStatus::Normal;
            thread.context_detail = None;
        }

        let thread_id = thread.id.clone();
        self.write_workspace(&workspace).await?;

        Ok(PendingRequestPlan {
            request_id,
            thread_id,
            assistant_message_id,
            model_alias: model_alias.to_string(),
            user_text: text,
            mode: args.mode,
            agent_depth,
            enabled_tools,
            attachments,
            previous_response_id,
        })
    }

    pub async fn patch_thread(
        &self,
        thread_id: &str,
        assistant_message_id: &str,
        patch: ThreadPatch,
    ) -> anyhow::Result<()> {
        let mut workspace = self.read_workspace().await?;
        let thread = workspace
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
            .with_context(|| format!("Thread {thread_id} not found."))?;
        let message = thread
            .messages
            .iter_mut()
            .find(|message| message.id == assistant_message_id)
            .with_context(|| format!("Message {assistant_message_id} not found in thread {thread_id}"))?;

        match patch {
            ThreadPatch::Success {
                text,
                response_id,
                invoked_tools,
                usage,
            } => {
                message.text = text;
                message.status = MessageStatus::Completed;
                message.response_id = response_id.clone();
                message.invoked_tools = invoked_tools;
                message.usage = usage;
                message.error = None;
                if response_id.is_some() {
                    thread.last_response_id = response_id;
                }
                thread.continuation_lost = false;
                thread.context_status = ThreadContextStatus::Normal;
                thread.context_detail = None;
            }
            ThreadPatch::Error {
                text,
                error,
                cancelled,
            } => {
                let lower_error = error.to_ascii_lowercase();
                let continuation_rejected = lower_error.contains("previous_response_id")
                    || lower_error.contains("continuation");

                message.text = text;
                message.status = if cancelled {
                    MessageStatus::Cancelled
                } else {
                    MessageStatus::Error
                };
                message.error = Some(error.clone());
                if continuation_rejected {
                    thread.last_response_id = None;
                    thread.continuation_lost = true;
                    thread.context_status = ThreadContextStatus::Lost;
                    thread.context_detail = Some(
                        "xAI rejected the saved continuation. The next send will start a fresh model context."
                            .into(),
                    );
                }
            }
        }

        thread.updated_at = now_string();
        self.write_workspace(&workspace).await
    }

    async fn collect_attachments(&self, paths: &[String]) -> anyhow::Result<Vec<AttachmentRecord>> {
        let mut attachments = Vec::new();

        for raw_path in paths {
            let path = PathBuf::from(raw_path);
            let metadata = fs::metadata(&path)
                .await
                .with_context(|| format!("Attachment not found: {}", path.display()))?;
            if !metadata.is_file() {
                bail!("Attachment must be a file: {}", path.display());
            }

            attachments.push(AttachmentRecord {
                id: Uuid::new_v4().to_string(),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("attachment")
                    .to_string(),
                path: path.display().to_string(),
                size_bytes: metadata.len(),
            });
        }

        Ok(attachments)
    }

    async fn load_settings_file(&self) -> anyhow::Result<SettingsFile> {
        let bytes = fs::read(&self.settings_path)
            .await
            .with_context(|| format!("Failed to read {}", self.settings_path.display()))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn read_workspace(&self) -> anyhow::Result<WorkspaceRecord> {
        let bytes = fs::read(&self.workspace_path)
            .await
            .with_context(|| format!("Failed to read {}", self.workspace_path.display()))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn write_workspace(&self, workspace: &WorkspaceRecord) -> anyhow::Result<()> {
        let payload = serde_json::to_vec_pretty(workspace)?;
        fs::write(&self.workspace_path, payload)
            .await
            .with_context(|| format!("Failed to write {}", self.workspace_path.display()))?;
        Ok(())
    }

    fn normalize_workspace(&self, workspace: &mut WorkspaceRecord) {
        if workspace.projects.is_empty() {
            workspace.projects.push(Self::default_project());
        }

        let default_project_id = workspace.projects[0].id.clone();
        let project_ids = workspace
            .projects
            .iter()
            .map(|project| project.id.clone())
            .collect::<std::collections::HashSet<_>>();

        for thread in &mut workspace.threads {
            if !project_ids.contains(&thread.project_id) {
                thread.project_id = default_project_id.clone();
            }
        }
    }

    fn load_legacy_workspace(&self) -> anyhow::Result<WorkspaceRecord> {
        if !self.threads_dir.exists() {
            return Ok(Self::default_workspace());
        }

        let project = Self::default_project();
        let mut threads = Vec::new();
        for entry in std::fs::read_dir(&self.threads_dir)? {
            let entry = entry?;
            if entry.path().extension() != Some(OsStr::new("json")) {
                continue;
            }

            let bytes = std::fs::read(entry.path())?;
            let legacy: LegacyThreadRecord = serde_json::from_slice(&bytes)?;
            threads.push(ThreadRecord {
                id: legacy.id,
                project_id: project.id.clone(),
                title: legacy.title,
                created_at: legacy.created_at,
                updated_at: legacy.updated_at,
                last_response_id: legacy.last_response_id,
                continuation_lost: false,
                context_status: ThreadContextStatus::Normal,
                context_detail: None,
                messages: legacy.messages,
            });
        }

        Ok(WorkspaceRecord {
            projects: vec![project],
            threads,
        })
    }

    fn default_workspace() -> WorkspaceRecord {
        WorkspaceRecord {
            projects: vec![Self::default_project()],
            threads: Vec::new(),
        }
    }

    fn default_project() -> ProjectRecord {
        let now = now_string();
        ProjectRecord {
            id: Uuid::new_v4().to_string(),
            name: DEFAULT_PROJECT_NAME.to_string(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn new_thread(project_id: String, title: Option<String>) -> ThreadRecord {
        let now = now_string();
        ThreadRecord {
            id: Uuid::new_v4().to_string(),
            project_id,
            title: title
                .map(|value| sanitize_title(&value))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| DEFAULT_THREAD_TITLE.to_string()),
            created_at: now.clone(),
            updated_at: now,
            last_response_id: None,
            continuation_lost: false,
            context_status: ThreadContextStatus::Normal,
            context_detail: None,
            messages: Vec::new(),
        }
    }
}

pub fn resolve_model_alias(mode: ChatMode, reasoning_enabled: bool) -> &'static str {
    match mode {
        ChatMode::Standard if reasoning_enabled => "grok-4.20-beta-latest",
        ChatMode::Standard => "grok-4.20-beta-latest-non-reasoning",
        ChatMode::Agent => "grok-4.20-multi-agent-beta-0309",
    }
}

fn now_string() -> String {
    Utc::now().to_rfc3339()
}

fn sanitize_title(value: &str) -> String {
    value.trim().replace('\n', " ")
}

fn build_thread_title(text: &str) -> String {
    let trimmed = sanitize_title(text);
    if trimmed.is_empty() {
        return DEFAULT_THREAD_TITLE.to_string();
    }

    if trimmed.chars().count() <= 48 {
        trimmed
    } else {
        truncate(&trimmed, 48)
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_aliases_are_routed_correctly() {
        assert_eq!(
            resolve_model_alias(ChatMode::Standard, false),
            "grok-4.20-beta-latest-non-reasoning"
        );
        assert_eq!(
            resolve_model_alias(ChatMode::Standard, true),
            "grok-4.20-beta-latest"
        );
        assert_eq!(
            resolve_model_alias(ChatMode::Agent, false),
            "grok-4.20-multi-agent-beta-0309"
        );
    }

    #[test]
    fn thread_titles_are_trimmed() {
        let title = build_thread_title(
            "This is a long first message that should become a shorter thread title",
        );
        assert!(title.ends_with("..."));
    }

    #[test]
    fn agent_depth_serialization_matches_frontend_shape() {
        let encoded = serde_json::to_string(&AgentDepth::Deep).unwrap();
        assert_eq!(encoded, "\"16\"");
    }

    #[test]
    fn default_workspace_contains_a_project() {
        let workspace = Storage::default_workspace();
        assert_eq!(workspace.projects.len(), 1);
        assert!(workspace.threads.is_empty());
    }
}
