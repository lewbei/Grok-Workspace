# GitHub Publish Checklist

Use this when creating the public repository for Grok Control.

## Recommended repo identity

- Name: `grok-control`
- Short description:
  `Grok-only desktop and web workspace built on xAI APIs with chat, deep research, tools, attachments, and local conversation history.`

## Recommended topics

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

## Before pushing

- Confirm `.env` is not committed
- Confirm `src-tauri/target` is not committed
- Confirm large screenshots or generated binaries are not committed unless intentionally needed
- Keep the root README as the main landing page

## Suggested first push flow

```bash
git init
git add .
git commit -m "Initial Grok Control release"
git branch -M main
git remote add origin https://github.com/<your-account>/grok-control.git
git push -u origin main
```

## After the repo exists

- Set the repository description
- Add the recommended topics
- Pin the repo on your profile if this is a flagship project
- Add a social preview image if you want better click-through from GitHub links
