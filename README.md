# Grok Control

A focused workspace for asking, exploring, and solving with Grok.

Grok Control is a Grok-only client that uses only the xAI API. It supports fast chat, deeper multi-agent research, built-in tools, attachments, local conversation history, and a desktop shell built with Tauri.

## What it is

- Grok chat with optional reasoning
- Deep Research mode backed by Grok 4.20 multi-agent
- Built-in `Web`, `X`, and `Code` tools
- Multi-turn conversation memory
- Text and code file attachments
- Usage and cost visibility
- Website debug surface plus desktop app

## xAI only

This project uses only an xAI API key.

- Desktop: save your xAI key in Settings
- Website: use `GROK_API_KEY` in `.env`

It does not use OpenAI keys, Anthropic keys, Gemini keys, or mixed-provider routing.

## Stack

- `React + TypeScript + Vite`
- `Tauri 2`
- `Rust`
- `Node + Express` for the website debug proxy

## Run the website

```bash
npm install
npm run dev
```

- Web UI: [http://localhost:1420](http://localhost:1420)
- Local proxy: [http://localhost:8787](http://localhost:8787)

## Build the desktop app

```bash
npm run tauri build -- --debug
```

## Environment

Create `.env` for the website debug surface:

```env
GROK_API_KEY=your_xai_key_here
```

## GitHub searchability

Recommended GitHub repo settings:

- Repository name: `grok-control`
- Description: `Grok-only desktop and web workspace built on xAI APIs with chat, deep research, tools, attachments, and local conversation history.`
- Topics:
  - `grok`
  - `xai`
  - `grok-4`
  - `grok-4-20`
  - `xai-api`
  - `deep-research`
  - `multi-agent`
  - `tauri`
  - `react`
  - `desktop-app`

## Docs

- Scenario matrix: [docs/scenario-matrix.md](C:/Users/lewka/deep_learning/grok/docs/scenario-matrix.md)
- Verification status: [docs/verification-status.md](C:/Users/lewka/deep_learning/grok/docs/verification-status.md)
- GitHub publish metadata: [docs/github-publish-checklist.md](C:/Users/lewka/deep_learning/grok/docs/github-publish-checklist.md)
