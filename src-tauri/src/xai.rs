use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context};
use futures_util::StreamExt;
use reqwest::{multipart, Client, Response};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::{
    models::{
        AgentEventPayload, AttachmentRecord, ChatDeltaPayload, ChatDonePayload, ChatErrorPayload,
        ChatMode, ChatToolPayload, ChatUsagePayload, FrontendToolName, PendingRequestPlan,
        ResponseUsage, ToolActivity, ToolCallUsage,
    },
    pricing::{estimate_costs, CostInputs, DEFAULT_PRICING},
    storage::{Storage, ThreadPatch},
};

const RESPONSES_URL: &str = "https://api.x.ai/v1/responses";
const FILES_URL: &str = "https://api.x.ai/v1/files";

#[derive(Clone)]
pub struct XaiClient {
    client: Client,
    api_key: String,
}

pub struct RequestRuntime {
    pub app: AppHandle,
    pub storage: Storage,
    pub api: XaiClient,
    pub request_id: String,
    pub thread_id: String,
    pub assistant_message_id: String,
    pub cancel_rx: watch::Receiver<bool>,
}

#[derive(Clone)]
struct RemoteAttachment {
    pub remote_file_id: String,
}

#[derive(Default)]
struct StreamAccumulator {
    text: String,
    final_response: Option<Value>,
    tool_call_ids: HashSet<String>,
    tool_counts: HashMap<FrontendToolName, u32>,
    tool_activities: Vec<ToolActivity>,
}

impl XaiClient {
    pub fn new(api_key: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
        }
    }

    async fn upload_attachment(&self, attachment: &AttachmentRecord) -> anyhow::Result<RemoteAttachment> {
        let file_path = std::path::PathBuf::from(&attachment.path);
        let bytes = tokio::fs::read(&file_path)
            .await
            .with_context(|| format!("Failed to read attachment {}", file_path.display()))?;

        let part = multipart::Part::bytes(bytes).file_name(attachment.name.clone());
        let form = multipart::Form::new()
            .text("purpose", "assistants")
            .part("file", part);

        let response = self
            .client
            .post(FILES_URL)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await
            .context("Failed to upload attachment to xAI.")?
            .error_for_status()
            .context("xAI rejected an attachment upload.")?;

        let payload: Value = response.json().await?;
        let file_id = payload
            .get("id")
            .and_then(Value::as_str)
            .context("xAI file upload response did not include a file id.")?
            .to_string();

        Ok(RemoteAttachment {
            remote_file_id: file_id,
        })
    }

    pub async fn delete_remote_file(&self, file_id: &str) -> anyhow::Result<()> {
        let url = format!("{FILES_URL}/{file_id}");
        let _ = self
            .client
            .delete(url)
            .bearer_auth(&self.api_key)
            .send()
            .await?;
        Ok(())
    }

    async fn start_stream(
        &self,
        plan: &PendingRequestPlan,
        attachments: &[RemoteAttachment],
    ) -> anyhow::Result<Response> {
        let mut content = Vec::new();
        if !plan.user_text.trim().is_empty() {
            content.push(json!({
                "type": "input_text",
                "text": plan.user_text,
            }));
        }

        for attachment in attachments {
            content.push(json!({
                "type": "input_file",
                "file_id": attachment.remote_file_id,
            }));
        }

        let mut payload = json!({
            "model": plan.model_alias,
            "stream": true,
            "input": [{
                "role": "user",
                "content": content,
            }],
        });

        if let Some(previous_response_id) = &plan.previous_response_id {
            payload["previous_response_id"] = json!(previous_response_id);
        }

        if matches!(plan.mode, ChatMode::Agent) {
            if let Some(depth) = plan.agent_depth {
                payload["reasoning"] = json!({
                    "effort": depth.effort(),
                });
            }
        }

        if !plan.enabled_tools.is_empty() {
            payload["tools"] = json!(
                plan.enabled_tools
                    .iter()
                    .map(|tool| json!({ "type": tool.api_name() }))
                    .collect::<Vec<_>>()
            );
        }

        self.client
            .post(RESPONSES_URL)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await
            .context("Failed to send the request to xAI.")?
            .error_for_status()
            .context("xAI rejected the request.")
    }
}

pub async fn process_request(
    mut runtime: RequestRuntime,
    plan: PendingRequestPlan,
) -> anyhow::Result<()> {
    let mut remote_attachments = Vec::new();
    let mut accumulator = StreamAccumulator::default();

    if matches!(plan.mode, ChatMode::Agent) {
        runtime.app.emit(
            "chat:agent",
            AgentEventPayload {
                request_id: runtime.request_id.clone(),
                thread_id: runtime.thread_id.clone(),
                assistant_message_id: runtime.assistant_message_id.clone(),
                phase: "started".into(),
                detail: format!(
                    "Running multi-agent research with {} agents.",
                    plan.agent_depth.map(|depth| depth.count()).unwrap_or(4)
                ),
            },
        )?;
    }

    let outcome = async {
        for attachment in &plan.attachments {
            remote_attachments
                .push(runtime.api.upload_attachment(attachment).await?);
        }

        let response = runtime.api.start_stream(&plan, &remote_attachments).await?;
        read_stream(&mut runtime, &plan, response, &mut accumulator).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    for attachment in &remote_attachments {
        let _ = runtime.api.delete_remote_file(&attachment.remote_file_id).await;
    }

    match outcome {
        Ok(()) => {
            let response_id = accumulator
                .final_response
                .as_ref()
                .and_then(|response| response.get("id"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);

            if accumulator.text.is_empty() {
                if let Some(response) = &accumulator.final_response {
                    accumulator.text = extract_output_text(response);
                }
            }

            let usage = accumulator
                .final_response
                .as_ref()
                .map(|response| build_usage(plan.mode, response, &accumulator.tool_counts));

            runtime
                .storage
                .patch_thread(
                    &runtime.thread_id,
                    &runtime.assistant_message_id,
                    ThreadPatch::Success {
                        text: accumulator.text.clone(),
                        response_id: response_id.clone(),
                        invoked_tools: accumulator.tool_activities.clone(),
                        usage: usage.clone(),
                    },
                )
                .await?;

            if let Some(usage_payload) = usage.clone() {
                runtime.app.emit(
                    "chat:usage",
                    ChatUsagePayload {
                        request_id: runtime.request_id.clone(),
                        thread_id: runtime.thread_id.clone(),
                        assistant_message_id: runtime.assistant_message_id.clone(),
                        usage: usage_payload,
                    },
                )?;
            }

            if matches!(plan.mode, ChatMode::Agent) {
                runtime.app.emit(
                    "chat:agent",
                    AgentEventPayload {
                        request_id: runtime.request_id.clone(),
                        thread_id: runtime.thread_id.clone(),
                        assistant_message_id: runtime.assistant_message_id.clone(),
                        phase: "completed".into(),
                        detail: "Multi-agent research finished.".into(),
                    },
                )?;
            }

            runtime.app.emit(
                "chat:done",
                ChatDonePayload {
                    request_id: runtime.request_id,
                    thread_id: runtime.thread_id,
                    assistant_message_id: runtime.assistant_message_id,
                    cancelled: false,
                    message: Some(accumulator.text),
                    response_id,
                    model_alias: Some(plan.model_alias),
                    usage,
                },
            )?;
        }
        Err(error) => {
            let cancelled = error.to_string().contains("Request cancelled");
            let message = if cancelled {
                "Request cancelled.".to_string()
            } else {
                error.to_string()
            };

            runtime
                .storage
                .patch_thread(
                    &runtime.thread_id,
                    &runtime.assistant_message_id,
                    ThreadPatch::Error {
                        text: accumulator.text.clone(),
                        error: message.clone(),
                        cancelled,
                    },
                )
                .await?;

            runtime.app.emit(
                "chat:error",
                ChatErrorPayload {
                    request_id: runtime.request_id.clone(),
                    thread_id: runtime.thread_id.clone(),
                    assistant_message_id: runtime.assistant_message_id.clone(),
                    code: Some(if cancelled {
                        "cancelled".into()
                    } else {
                        "request_failed".into()
                    }),
                    message,
                },
            )?;

            runtime.app.emit(
                "chat:done",
                ChatDonePayload {
                    request_id: runtime.request_id,
                    thread_id: runtime.thread_id,
                    assistant_message_id: runtime.assistant_message_id,
                    cancelled,
                    message: None,
                    response_id: None,
                    model_alias: Some(plan.model_alias),
                    usage: None,
                },
            )?;
        }
    }

    Ok(())
}

async fn read_stream(
    runtime: &mut RequestRuntime,
    plan: &PendingRequestPlan,
    response: Response,
    accumulator: &mut StreamAccumulator,
) -> anyhow::Result<()> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        tokio::select! {
            changed = runtime.cancel_rx.changed() => {
                if changed.is_ok() && *runtime.cancel_rx.borrow() {
                    bail!("Request cancelled");
                }
            }
            maybe_chunk = stream.next() => {
                match maybe_chunk {
                    Some(Ok(chunk)) => {
                        let chunk_text = std::str::from_utf8(&chunk).context("xAI returned invalid UTF-8 in the stream.")?;
                        buffer.push_str(chunk_text);

                        while let Some(index) = buffer.find("\n\n") {
                            let frame = buffer[..index].to_string();
                            buffer.drain(..index + 2);
                            handle_sse_frame(runtime, plan, accumulator, &frame).await?;
                        }
                    }
                    Some(Err(error)) => return Err(error).context("Stream connection failed."),
                    None => break,
                }
            }
        }
    }

    if !buffer.trim().is_empty() {
        handle_sse_frame(runtime, plan, accumulator, &buffer).await?;
    }

    Ok(())
}

async fn handle_sse_frame(
    runtime: &RequestRuntime,
    plan: &PendingRequestPlan,
    accumulator: &mut StreamAccumulator,
    frame: &str,
) -> anyhow::Result<()> {
    let mut data_lines = Vec::new();

    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }

    if data_lines.is_empty() {
        return Ok(());
    }

    let payload = data_lines.join("\n");
    if payload.trim() == "[DONE]" {
        return Ok(());
    }

    let value: Value = serde_json::from_str(&payload)?;
    handle_stream_value(runtime, plan, accumulator, &value).await
}

async fn handle_stream_value(
    runtime: &RequestRuntime,
    plan: &PendingRequestPlan,
    accumulator: &mut StreamAccumulator,
    value: &Value,
) -> anyhow::Result<()> {
    if let Some(delta) = response_text_delta(value) {
        accumulator.text.push_str(&delta);
        runtime.app.emit(
            "chat:delta",
            ChatDeltaPayload {
                request_id: runtime.request_id.clone(),
                thread_id: runtime.thread_id.clone(),
                assistant_message_id: runtime.assistant_message_id.clone(),
                delta,
            },
        )?;
    }

    if let Some(event_type) = value.get("type").and_then(Value::as_str) {
        match event_type {
            "response.output_item.added" | "response.output_item.done" => {
                if let Some(item) = value.get("item").or_else(|| value.get("output_item")) {
                    maybe_emit_tool(runtime, accumulator, item, event_type.ends_with("done"))?;
                }
            }
            "response.completed" => {
                accumulator.final_response = value.get("response").cloned();
            }
            _ => {}
        }
    } else if value.get("output").is_some() && value.get("id").is_some() {
        accumulator.final_response = Some(value.clone());
    }

    if matches!(plan.mode, ChatMode::Agent) {
        if let Some(event_type) = value.get("type").and_then(Value::as_str) {
            if event_type.contains("response.output_item.added") {
                runtime.app.emit(
                    "chat:agent",
                    AgentEventPayload {
                        request_id: runtime.request_id.clone(),
                        thread_id: runtime.thread_id.clone(),
                        assistant_message_id: runtime.assistant_message_id.clone(),
                        phase: "progress".into(),
                        detail: "Multi-agent response is still running.".into(),
                    },
                )?;
            }
        }
    }

    Ok(())
}

fn maybe_emit_tool(
    runtime: &RequestRuntime,
    accumulator: &mut StreamAccumulator,
    value: &Value,
    completed: bool,
) -> anyhow::Result<()> {
    let Some(tool) = extract_tool(value) else {
        return Ok(());
    };

    let call_id = value
        .get("id")
        .or_else(|| value.get("call_id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{}-{}", tool.api_name(), accumulator.tool_activities.len()));

    if !accumulator.tool_call_ids.insert(call_id) && !completed {
        return Ok(());
    }

    *accumulator.tool_counts.entry(tool).or_insert(0) += 1;

    let status = if completed { "completed" } else { "started" }.to_string();
    let activity = ToolActivity {
        tool,
        label: tool.label().to_string(),
        status: status.clone(),
    };
    accumulator.tool_activities.push(activity.clone());

    runtime.app.emit(
        "chat:tool",
        ChatToolPayload {
            request_id: runtime.request_id.clone(),
            thread_id: runtime.thread_id.clone(),
            assistant_message_id: runtime.assistant_message_id.clone(),
            tool,
            label: activity.label,
            status,
        },
    )?;

    Ok(())
}

fn extract_tool(value: &Value) -> Option<FrontendToolName> {
    if let Some(tool_type) = value.get("type").and_then(Value::as_str) {
        if let Some(tool) = FrontendToolName::from_event_type(tool_type) {
            return Some(tool);
        }
    }

    let rendered = serde_json::to_string(value).ok()?;
    FrontendToolName::from_event_type(&rendered)
}

fn response_text_delta(value: &Value) -> Option<String> {
    if let Some(event_type) = value.get("type").and_then(Value::as_str) {
        if event_type == "response.output_text.delta" {
            return value.get("delta").and_then(Value::as_str).map(ToOwned::to_owned);
        }
    }

    if let Some(content) = value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
        return Some(content.to_string());
    }

    if let Some(content) = value
        .pointer("/choices/0/delta/content/0/text")
        .and_then(Value::as_str)
    {
        return Some(content.to_string());
    }

    None
}

fn extract_output_text(value: &Value) -> String {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .flat_map(|item| item.get("content").and_then(Value::as_array).into_iter().flatten())
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn build_usage(
    mode: ChatMode,
    response: &Value,
    tool_counts: &HashMap<FrontendToolName, u32>,
) -> ResponseUsage {
    let usage = response.get("usage").cloned().unwrap_or(Value::Null);
    let input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let reasoning_tokens = usage
        .get("reasoning_tokens")
        .or_else(|| usage.pointer("/output_tokens_details/reasoning_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cached_input_tokens = usage
        .get("cached_input_tokens")
        .or_else(|| usage.pointer("/input_tokens_details/cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or_default();

    let billed_total_usd = usage
        .get("cost_in_usd")
        .and_then(Value::as_f64)
        .or_else(|| usage.get("total_cost_usd").and_then(Value::as_f64));

    let web_calls = *tool_counts.get(&FrontendToolName::WebSearch).unwrap_or(&0);
    let x_calls = *tool_counts.get(&FrontendToolName::XSearch).unwrap_or(&0);
    let code_calls = *tool_counts.get(&FrontendToolName::CodeInterpreter).unwrap_or(&0);

    let estimated_costs = estimate_costs(
        &DEFAULT_PRICING,
        CostInputs {
            mode,
            input_tokens,
            output_tokens,
            reasoning_tokens,
            cached_input_tokens,
            web_calls,
            x_calls,
            code_calls,
            billed_total_usd,
        },
    );

    let mut tool_calls = Vec::new();
    for (tool, count) in tool_counts {
        tool_calls.push(ToolCallUsage {
            tool: *tool,
            count: *count,
        });
    }
    tool_calls.sort_by_key(|entry| entry.tool.label().to_string());

    ResponseUsage {
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_input_tokens,
        tool_calls,
        estimated_costs,
        billed_total_usd,
    }
}
