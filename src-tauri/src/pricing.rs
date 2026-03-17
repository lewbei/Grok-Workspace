use serde::{Deserialize, Serialize};

use crate::models::ChatMode;

pub const PRICING_CONFIG_VERSION: &str = "2026-03-xai-estimated-v1";

#[derive(Debug, Clone, Copy)]
pub struct PricingProfile {
    pub input_per_million: f64,
    pub cached_input_per_million: f64,
    pub output_per_million: f64,
    pub reasoning_per_million: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct PricingConfig {
    pub standard: PricingProfile,
    pub agent: PricingProfile,
    pub web_call: f64,
    pub x_call: f64,
    pub code_call: f64,
}

pub const DEFAULT_PRICING: PricingConfig = PricingConfig {
    // xAI can change these rates. Keep them in one place so updating the
    // estimate path does not require touching storage or UI code.
    standard: PricingProfile {
        input_per_million: 3.0,
        cached_input_per_million: 0.75,
        output_per_million: 15.0,
        reasoning_per_million: 15.0,
    },
    agent: PricingProfile {
        input_per_million: 3.0,
        cached_input_per_million: 0.75,
        output_per_million: 15.0,
        reasoning_per_million: 15.0,
    },
    web_call: 0.005,
    x_call: 0.005,
    code_call: 0.005,
};

#[derive(Debug, Clone, Copy)]
pub struct CostInputs {
    pub mode: ChatMode,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_input_tokens: u64,
    pub web_calls: u32,
    pub x_calls: u32,
    pub code_calls: u32,
    pub billed_total_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    pub input_usd: f64,
    pub output_usd: f64,
    pub reasoning_usd: f64,
    pub cached_input_usd: f64,
    pub tools_usd: f64,
    pub total_usd: f64,
}

fn round_currency(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

pub fn estimate_costs(config: &PricingConfig, inputs: CostInputs) -> CostBreakdown {
    let profile = match inputs.mode {
        ChatMode::Standard => config.standard,
        ChatMode::Agent => config.agent,
    };

    let input_usd = (inputs.input_tokens as f64 / 1_000_000.0) * profile.input_per_million;
    let cached_input_usd =
        (inputs.cached_input_tokens as f64 / 1_000_000.0) * profile.cached_input_per_million;
    let output_usd = (inputs.output_tokens as f64 / 1_000_000.0) * profile.output_per_million;
    let reasoning_usd =
        (inputs.reasoning_tokens as f64 / 1_000_000.0) * profile.reasoning_per_million;
    let tools_usd = (inputs.web_calls as f64 * config.web_call)
        + (inputs.x_calls as f64 * config.x_call)
        + (inputs.code_calls as f64 * config.code_call);

    let estimated_total = input_usd + cached_input_usd + output_usd + reasoning_usd + tools_usd;
    let total_usd = inputs.billed_total_usd.unwrap_or(estimated_total);

    CostBreakdown {
        input_usd: round_currency(input_usd),
        output_usd: round_currency(output_usd),
        reasoning_usd: round_currency(reasoning_usd),
        cached_input_usd: round_currency(cached_input_usd),
        tools_usd: round_currency(tools_usd),
        total_usd: round_currency(total_usd),
    }
}
