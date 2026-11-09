# Discord GitHub Issue Bot (Cloudflare Worker)

This bot exposes Discord slash commands that operate on one configured GitHub repository:

- `/issue-create` - create an issue
- `/issue-search` - search issues
- `/issue-label` - add/set/remove issue labels

The bot runs as a Cloudflare Worker and uses Discord interactions (webhook-style), so no long-running server is needed.

By default, bot command responses are public in-channel (visible to everyone).

## Prerequisites

- Node.js 20+
- A Cloudflare account
- A Discord application + bot
- A GitHub token with repository issue permissions (`repo` for private repos, or `public_repo` for public repos)

## 1) Create Discord application and bot

1. Go to Discord Developer Portal and create an application.
2. In **Bot**, create a bot user and copy the bot token.
3. In **General Information**, copy:
   - Application ID
   - Public Key

## 2) Configure local project

```bash
npm install
```

Create `.dev.vars` for local `wrangler dev`:

```env
DISCORD_PUBLIC_KEY=your_discord_public_key
GITHUB_TOKEN=your_github_token
GITHUB_OWNER=your_github_owner_or_org
GITHUB_REPO=your_repo_name
```

Optional:

```env
GITHUB_API_BASE=https://api.github.com
```

## 3) Set Cloudflare Worker secrets

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_OWNER
npx wrangler secret put GITHUB_REPO
```

Optional:

```bash
npx wrangler secret put GITHUB_API_BASE
```

## 4) Deploy the worker

```bash
npm run deploy
```

Copy the deployed worker URL, for example:

`https://discord-issue-bot.<your-subdomain>.workers.dev`

## 5) Point Discord interactions to the worker

In Discord Developer Portal → **General Information**:

- Set **Interactions Endpoint URL** to your worker URL
- Save and verify (Discord sends a ping request; the worker responds automatically)

## 6) Register slash commands

Set env vars for the registration script:

```bash
export DISCORD_BOT_TOKEN=your_bot_token
export DISCORD_APPLICATION_ID=your_application_id
```

For fast testing in one server, set a guild ID:

```bash
export DISCORD_GUILD_ID=your_server_id
```

Register commands:

```bash
npm run register:commands
```

If `DISCORD_GUILD_ID` is set, commands are guild-scoped (fast propagation).  
If not set, commands are global (can take longer to appear).

## 7) Invite bot to your server

Use OAuth2 URL Generator with scopes:

- `bot`
- `applications.commands`

Grant permissions appropriate for your server.

## Slash command usage

Create issue:

```text
/issue-create title:"API bug" body:"Steps to reproduce..." labels:"bug,triage"
```

Search issues:

```text
/issue-search query:"login timeout" state:open limit:5
```

Search behavior:

- If your query uses GitHub qualifiers like `label:bug` or `author:...`, the bot uses GitHub's native issue search.
- Otherwise, it runs a fuzzy match against recent repository issues (title + body) to handle approximate terms and typos.
- If fuzzy confidence is weak, it falls back to GitHub native search automatically.
- Issue URLs are formatted to avoid Discord GitHub embeds in responses.

Label issue:

```text
/issue-label number:42 labels:"priority-high,backend" mode:add
```

Modes:

- `add`: append labels
- `set`: replace all labels with provided list
- `remove`: remove provided labels

## Cloudflare alerts

The worker also accepts Cloudflare notification webhooks at `POST /cloudflare-alerts` and posts each alert to the Discord channel set by `DISCORD_ALERTS_CHANNEL_ID` in `wrangler.toml` (#developers-only by default).

1. Set the secrets:

   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put CLOUDFLARE_WEBHOOK_SECRET
   ```

   `CLOUDFLARE_WEBHOOK_SECRET` is any random string, for example from `openssl rand -hex 32`.
2. Make sure the bot is in the server and can **View Channel** and **Send Messages** in the alerts channel.
3. In the Cloudflare dashboard, go to **Notifications → Destinations → Webhooks → Create**:
   - URL: `https://discord-issue-bot.<your-subdomain>.workers.dev/cloudflare-alerts`
   - Secret: the same value as `CLOUDFLARE_WEBHOOK_SECRET`
   - Select **Save and Test**. A test message should appear in the channel.
4. Add the webhook as a destination on each notification you want forwarded.

Requests without a matching `cf-webhook-auth` header are rejected.

## Local development

```bash
npm run dev
```

Then use a public HTTPS tunnel or deployed URL for Discord interaction testing.

## Validation

```bash
npm run typecheck
```
