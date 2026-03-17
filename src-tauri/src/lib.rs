mod models;
mod pricing;
mod storage;
mod xai;

use std::{collections::HashMap, sync::Arc};

use anyhow::Context;
use models::{
    AppSettingsResponse, CancelRequestArgs, ChatErrorPayload, ClearAllThreadsResponse,
    CreateThreadArgs, CreateThreadResponse, DeleteThreadArgs, DescribeAttachmentsArgs,
    LoadThreadArgs, SaveApiKeyArgs, SaveThemeArgs, SaveWorkspaceArgs, SendMessageArgs,
    SendMessageResponse, ThreadRecord, ThreadSummary, WorkspaceRecord,
};
use storage::Storage;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, RwLock};
use xai::{process_request, RequestRuntime, XaiClient};

#[derive(Clone, Default)]
struct AppState {
    running_requests: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    thread_locks: Arc<Mutex<HashMap<String, Arc<RwLock<()>>>>>,
}

type CommandResult<T> = Result<T, String>;

fn emit_error(app: &AppHandle, payload: ChatErrorPayload) {
    let _ = app.emit("chat:error", payload);
}

async fn with_thread_lock<F, Fut, T>(
    state: &AppState,
    thread_id: &str,
    operation: F,
) -> anyhow::Result<T>
where
    F: FnOnce(Arc<RwLock<()>>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let lock = {
        let mut locks = state.thread_locks.lock().await;
        locks.entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(RwLock::new(())))
            .clone()
    };

    operation(lock).await
}

fn to_command_error(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[tauri::command]
async fn load_settings(app: AppHandle) -> CommandResult<AppSettingsResponse> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.load_settings().await.map_err(to_command_error)
}

#[tauri::command]
async fn save_api_key(app: AppHandle, args: SaveApiKeyArgs) -> CommandResult<()> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.save_api_key(&args.api_key).map_err(to_command_error)
}

#[tauri::command]
async fn remove_api_key(app: AppHandle) -> CommandResult<()> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.remove_api_key().map_err(to_command_error)
}

#[tauri::command]
async fn save_theme(app: AppHandle, args: SaveThemeArgs) -> CommandResult<()> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.save_theme(args.theme).await.map_err(to_command_error)
}

#[tauri::command]
async fn load_workspace(app: AppHandle) -> CommandResult<WorkspaceRecord> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.load_workspace().await.map_err(to_command_error)
}

#[tauri::command]
async fn save_workspace(app: AppHandle, args: SaveWorkspaceArgs) -> CommandResult<WorkspaceRecord> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.save_workspace(args).await.map_err(to_command_error)
}

#[tauri::command]
async fn list_threads(app: AppHandle) -> CommandResult<Vec<ThreadSummary>> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.list_threads().await.map_err(to_command_error)
}

#[tauri::command]
async fn create_thread(app: AppHandle, args: CreateThreadArgs) -> CommandResult<CreateThreadResponse> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    let thread = storage
        .create_thread(args.title)
        .await
        .map_err(to_command_error)?;
    Ok(CreateThreadResponse { thread })
}

#[tauri::command]
async fn load_thread(app: AppHandle, args: LoadThreadArgs) -> CommandResult<ThreadRecord> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage.load_thread(&args.thread_id).await.map_err(to_command_error)
}

#[tauri::command]
async fn delete_thread(app: AppHandle, args: DeleteThreadArgs) -> CommandResult<()> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage
        .delete_thread(&args.thread_id)
        .await
        .map_err(to_command_error)
}

#[tauri::command]
async fn clear_all_threads(app: AppHandle) -> CommandResult<ClearAllThreadsResponse> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage
        .clear_all_threads()
        .await
        .map_err(to_command_error)
        .map(|deleted| ClearAllThreadsResponse { deleted })
}

#[tauri::command]
async fn describe_attachment_paths(
    app: AppHandle,
    args: DescribeAttachmentsArgs,
) -> CommandResult<Vec<models::AttachmentRecord>> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    storage
        .describe_attachment_paths(&args.attachment_paths)
        .await
        .map_err(to_command_error)
}

#[tauri::command]
async fn cancel_request(
    state: State<'_, AppState>,
    args: CancelRequestArgs,
) -> CommandResult<()> {
    let sender = {
        let mut running = state.running_requests.lock().await;
        running.remove(&args.request_id)
    };

    if let Some(sender) = sender {
        let _ = sender.send(true);
    }

    Ok(())
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SendMessageArgs,
) -> CommandResult<SendMessageResponse> {
    let storage = Storage::new(&app).map_err(to_command_error)?;
    let api_key = storage
        .load_api_key()
        .context("No API key configured. Save your xAI API key in Settings before sending.")
        .map_err(to_command_error)?;

    let request_plan = storage
        .prepare_outgoing_request(&args)
        .await
        .map_err(to_command_error)?;
    let workspace = storage.load_workspace().await.map_err(to_command_error)?;

    let request_id = request_plan.request_id.clone();
    let assistant_message_id = request_plan.assistant_message_id.clone();
    let thread_id = request_plan.thread_id.clone();

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut running = state.running_requests.lock().await;
        running.insert(request_id.clone(), cancel_tx);
    }

    let app_for_task = app.clone();
    let state_for_task = app.state::<AppState>().inner().clone();
    let runtime = RequestRuntime {
        app: app.clone(),
        storage,
        api: XaiClient::new(api_key),
        request_id: request_id.clone(),
        thread_id: thread_id.clone(),
        assistant_message_id: assistant_message_id.clone(),
        cancel_rx,
    };

    let response_request_id = request_id.clone();
    tokio::spawn(async move {
        let outcome = with_thread_lock(&state_for_task, &thread_id, |lock| async move {
            let _guard = lock.write().await;
            process_request(runtime, request_plan).await
        })
        .await;

        {
            let mut running = state_for_task.running_requests.lock().await;
            running.remove(&request_id);
        }

        if let Err(error) = outcome {
            emit_error(
                &app_for_task,
                ChatErrorPayload {
                    request_id,
                    thread_id,
                    assistant_message_id,
                    code: Some("request_failed".into()),
                    message: error.to_string(),
                },
            );
        }
    });

    Ok(SendMessageResponse {
        request_id: response_request_id,
        workspace,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_api_key,
            remove_api_key,
            save_theme,
            load_workspace,
            save_workspace,
            list_threads,
            create_thread,
            load_thread,
            send_message,
            cancel_request,
            delete_thread,
            clear_all_threads,
            describe_attachment_paths
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = Storage::new(&handle).and_then(|storage| storage.ensure_layout()) {
                    emit_error(
                        &handle,
                        ChatErrorPayload {
                            request_id: "bootstrap".into(),
                            thread_id: String::new(),
                            assistant_message_id: String::new(),
                            code: Some("bootstrap".into()),
                            message: format!("Failed to prepare app storage: {error:#}"),
                        },
                    );
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use crate::models::{AgentDepth, ChatMode, FrontendTheme};
    use crate::pricing::{
        estimate_costs, CostInputs, DEFAULT_PRICING, PRICING_CONFIG_VERSION,
    };

    #[test]
    fn pricing_version_is_stable() {
        assert!(!PRICING_CONFIG_VERSION.is_empty());
    }

    #[test]
    fn agent_costs_use_agent_profile() {
        let usage = estimate_costs(
            &DEFAULT_PRICING,
            CostInputs {
                mode: ChatMode::Agent,
                input_tokens: 1_000,
                output_tokens: 2_000,
                reasoning_tokens: 300,
                cached_input_tokens: 100,
                web_calls: 0,
                x_calls: 0,
                code_calls: 1,
                billed_total_usd: None,
            },
        );

        assert!(usage.total_usd > 0.0);
        assert_eq!(usage.tools_usd, 0.005);
    }

    #[test]
    fn theme_defaults_are_serializable() {
        let theme = FrontendTheme::System;
        let encoded = serde_json::to_string(&theme).unwrap();
        assert_eq!(encoded, "\"system\"");
    }

    #[test]
    fn thread_modes_round_trip() {
        let depth = AgentDepth::Quick;
        let encoded = serde_json::to_string(&(ChatMode::Standard, depth)).unwrap();
        assert!(encoded.contains("standard"));
        assert!(encoded.contains("4"));
    }
}
