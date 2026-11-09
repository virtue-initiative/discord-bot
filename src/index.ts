import nacl from "tweetnacl";

interface Env {
  DISCORD_PUBLIC_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_API_BASE?: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_ALERTS_CHANNEL_ID: string;
  CLOUDFLARE_WEBHOOK_SECRET: string;
}

type CloudflareAlert = {
  name?: string;
  text?: string;
  data?: Record<string, unknown>;
  ts?: number;
  account_id?: string;
  policy_id?: string;
  policy_name?: string;
  alert_type?: string;
  alert_correlation_id?: string;
  alert_event?: string;
};

type DiscordCommandOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
};

type DiscordInteraction = {
  type: number;
  data?: {
    name: string;
    options?: DiscordCommandOption[];
  };
};

type InteractionResponse = {
  type: number;
  data?: {
    content: string;
    flags?: number;
  };
};

type GitHubIssue = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
};

const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_RESPONSE_PONG = 1;
const DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;

const COMMAND_CREATE = "issue-create";
const COMMAND_SEARCH = "issue-search";
const COMMAND_LABEL = "issue-label";

const CLOUDFLARE_ALERTS_PATH = "/cloudflare-alerts";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_MESSAGE_MAX_LENGTH = 2000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (new URL(request.url).pathname === CLOUDFLARE_ALERTS_PATH) {
      return handleCloudflareAlert(request, env);
    }

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");

    if (!signature || !timestamp) {
      return new Response("Missing Discord signature headers", { status: 401 });
    }

    const rawBody = await request.text();

    const isValid = verifyDiscordRequest(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return new Response("Invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody) as DiscordInteraction;

    if (interaction.type === DISCORD_INTERACTION_PING) {
      return jsonResponse({ type: DISCORD_RESPONSE_PONG });
    }

    if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND || !interaction.data) {
      return jsonResponse(message("Unsupported interaction type"));
    }

    try {
      const commandName = interaction.data.name;
      if (commandName === COMMAND_CREATE) {
        return jsonResponse(await handleCreateIssue(interaction, env));
      }

      if (commandName === COMMAND_SEARCH) {
        return jsonResponse(await handleSearchIssues(interaction, env));
      }

      if (commandName === COMMAND_LABEL) {
        return jsonResponse(await handleLabelIssue(interaction, env));
      }

      return jsonResponse(message(`Unknown command: ${commandName}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unhandled error";
      return jsonResponse(messageResponse(`Error: ${message}`));
    }
  }
};

function verifyDiscordRequest(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKey: string
): boolean {
  const message = new TextEncoder().encode(`${timestamp}${rawBody}`);
  const signatureBytes = hexToUint8Array(signature);
  const publicKeyBytes = hexToUint8Array(publicKey);
  return nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
}

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const value = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid hex string value");
    }
    bytes[i / 2] = value;
  }
  return bytes;
}

async function handleCloudflareAlert(request: Request, env: Env): Promise<Response> {
  const providedSecret = request.headers.get("cf-webhook-auth");
  if (!providedSecret || !(await secretsMatch(providedSecret, env.CLOUDFLARE_WEBHOOK_SECRET))) {
    return new Response("Invalid webhook secret", { status: 401 });
  }

  let alert: CloudflareAlert;
  try {
    alert = (await request.json()) as CloudflareAlert;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  await postDiscordChannelMessage(env, env.DISCORD_ALERTS_CHANNEL_ID, formatCloudflareAlert(alert));
  return new Response("OK", { status: 200 });
}

async function secretsMatch(a: string, b: string): Promise<boolean> {
  if (!b) {
    return false;
  }
  // Hash first so timingSafeEqual gets equal-length inputs.
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

function formatCloudflareAlert(alert: CloudflareAlert): string {
  const resolved = alert.alert_event === "ALERT_STATE_EVENT_END";
  const title = alert.name ?? alert.policy_name ?? "Cloudflare notification";
  const lines = [`${resolved ? "✅" : "🚨"} **${title}**${resolved ? " (resolved)" : ""}`];

  if (alert.text) {
    lines.push(alert.text);
  }

  const details: string[] = [];
  if (alert.alert_type) {
    details.push(`Type: \`${alert.alert_type}\``);
  }
  if (typeof alert.ts === "number") {
    details.push(`<t:${alert.ts}:f>`);
  }
  if (details.length > 0) {
    lines.push(details.join(" · "));
  }

  const dashboardLink = alert.data?.dashboard_link;
  if (typeof dashboardLink === "string" && dashboardLink.startsWith("https://")) {
    lines.push(suppressEmbedUrl(dashboardLink));
  }

  const content = lines.join("\n");
  return content.length > DISCORD_MESSAGE_MAX_LENGTH
    ? `${content.slice(0, DISCORD_MESSAGE_MAX_LENGTH - 1)}…`
    : content;
}

async function postDiscordChannelMessage(env: Env, channelId: string, content: string): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API error ${response.status}: ${body}`);
  }
}

function getOption(interaction: DiscordInteraction, name: string): string | number | boolean | undefined {
  return interaction.data?.options?.find((option) => option.name === name)?.value;
}

function parseLabelList(labelsRaw: string): string[] {
  return labelsRaw
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

async function handleCreateIssue(interaction: DiscordInteraction, env: Env): Promise<InteractionResponse> {
  const title = getOption(interaction, "title");
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("`title` is required.");
  }

  const body = getOption(interaction, "body");
  const labelsRaw = getOption(interaction, "labels");
  const labels = typeof labelsRaw === "string" ? parseLabelList(labelsRaw) : [];

  const issue = await githubRequest<GitHubIssue>(
    env,
    `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title: title.trim(),
        body: typeof body === "string" && body.trim().length > 0 ? body.trim() : undefined,
        labels: labels.length > 0 ? labels : undefined
      })
    }
  );

  return message(`Created issue #${issue.number}: ${issue.title} (${suppressEmbedUrl(issue.html_url)})`);
}

async function handleSearchIssues(interaction: DiscordInteraction, env: Env): Promise<InteractionResponse> {
  const queryValue = getOption(interaction, "query");
  if (typeof queryValue !== "string" || queryValue.trim().length === 0) {
    throw new Error("`query` is required.");
  }

  const stateValue = getOption(interaction, "state");
  const state = typeof stateValue === "string" ? stateValue : "open";
  if (!["open", "closed", "all"].includes(state)) {
    throw new Error("`state` must be open, closed, or all.");
  }

  const limitValue = getOption(interaction, "limit");
  const limit = typeof limitValue === "number" ? Math.trunc(limitValue) : 5;
  if (limit < 1 || limit > 10) {
    throw new Error("`limit` must be between 1 and 10.");
  }

  const query = queryValue.trim();
  if (hasGitHubQualifier(query)) {
    const nativeMatches = await searchIssuesNative(env, query, state, limit);
    if (nativeMatches.length === 0) {
      return message("No matching issues found.");
    }
    return message(formatIssueLines(nativeMatches));
  }

  const issues = await fetchRepositoryIssues(env, state);
  const ranked = issues
    .map((issue) => ({
      issue,
      score: fuzzyIssueScore(query, issue)
    }))
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const hasStrongFuzzyMatch = ranked.length > 0 && ranked[0].score >= 0.5;
  if (!hasStrongFuzzyMatch) {
    const nativeMatches = await searchIssuesNative(env, query, state, limit);
    if (nativeMatches.length === 0) {
      return message("No matching issues found.");
    }
    return message(formatIssueLines(nativeMatches));
  }

  const lines = ranked.map(({ issue }) => formatIssueLine(issue));

  return message(lines.join("\n"));
}

async function handleLabelIssue(interaction: DiscordInteraction, env: Env): Promise<InteractionResponse> {
  const issueNumberValue = getOption(interaction, "number");
  if (typeof issueNumberValue !== "number" || !Number.isInteger(issueNumberValue) || issueNumberValue < 1) {
    throw new Error("`number` must be a positive integer.");
  }

  const labelsValue = getOption(interaction, "labels");
  if (typeof labelsValue !== "string" || labelsValue.trim().length === 0) {
    throw new Error("`labels` is required.");
  }

  const labels = parseLabelList(labelsValue);
  if (labels.length === 0) {
    throw new Error("`labels` must contain at least one label.");
  }

  const modeValue = getOption(interaction, "mode");
  const mode = typeof modeValue === "string" ? modeValue : "add";
  if (!["add", "set", "remove"].includes(mode)) {
    throw new Error("`mode` must be add, set, or remove.");
  }

  const issuePath = `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/issues/${issueNumberValue}/labels`;
  if (mode === "add") {
    const response = await githubRequest<Array<{ name: string }>>(env, issuePath, {
      method: "POST",
      body: JSON.stringify({ labels })
    });
    const labelText = response.map((label) => label.name).join(", ");
    return message(`Updated labels on #${issueNumberValue}: ${labelText || "(none)"}`);
  }

  if (mode === "set") {
    const response = await githubRequest<Array<{ name: string }>>(env, issuePath, {
      method: "PUT",
      body: JSON.stringify({ labels })
    });
    const labelText = response.map((label) => label.name).join(", ");
    return message(`Set labels on #${issueNumberValue}: ${labelText || "(none)"}`);
  }

  for (const label of labels) {
    await githubRequest<void>(env, `${issuePath}/${encodeURIComponent(label)}`, { method: "DELETE" });
  }
  return message(`Removed labels from #${issueNumberValue}: ${labels.join(", ")}`);
}

function hasGitHubQualifier(query: string): boolean {
  return /\b[a-zA-Z-]+:/.test(query);
}

async function searchIssuesNative(env: Env, query: string, state: string, limit: number): Promise<GitHubIssue[]> {
  const stateQueryPart = state === "all" ? "" : ` state:${state}`;
  const q = `${query} repo:${env.GITHUB_OWNER}/${env.GITHUB_REPO} is:issue${stateQueryPart}`;
  const params = new URLSearchParams({
    q,
    per_page: String(limit)
  });
  const result = await githubRequest<{ items: GitHubIssue[] }>(env, `/search/issues?${params.toString()}`);
  return result.items;
}

function formatIssueLines(issues: GitHubIssue[]): string {
  return issues.map((issue) => formatIssueLine(issue)).join("\n");
}

function formatIssueLine(issue: GitHubIssue): string {
  const labels = issue.labels.map((label) => label.name).join(", ");
  return `• #${issue.number} ${issue.title} (${suppressEmbedUrl(issue.html_url)}) (${issue.state}${labels ? ` | ${labels}` : ""})`;
}

function suppressEmbedUrl(url: string): string {
  return `<${url}>`;
}

async function fetchRepositoryIssues(env: Env, state: string): Promise<GitHubIssue[]> {
  const states = state === "all" ? ["open", "closed"] : [state];
  const issues: GitHubIssue[] = [];

  for (const currentState of states) {
    for (let page = 1; page <= 2; page += 1) {
      const params = new URLSearchParams({
        state: currentState,
        per_page: "100",
        page: String(page)
      });
      const pageIssues = await githubRequest<GitHubIssue[]>(
        env,
        `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/issues?${params.toString()}`
      );
      const realIssues = pageIssues.filter((issue) => issue.pull_request === undefined);
      issues.push(...realIssues);
      if (pageIssues.length < 100) {
        break;
      }
    }
  }

  return issues;
}

function fuzzyIssueScore(query: string, issue: GitHubIssue): number {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length === 0) {
    return 0;
  }

  const haystack = `${issue.title} ${issue.body ?? ""}`;
  const normalizedHaystack = normalizeText(haystack);
  if (normalizedHaystack.includes(normalizedQuery)) {
    return 1;
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const issueTokens = normalizedHaystack.split(" ").filter(Boolean);
  if (queryTokens.length === 0 || issueTokens.length === 0) {
    return 0;
  }

  let tokenScoreSum = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const issueToken of issueTokens) {
      const score = tokenSimilarity(queryToken, issueToken);
      if (score > best) {
        best = score;
      }
      if (best >= 1) {
        break;
      }
    }
    tokenScoreSum += best;
  }

  return tokenScoreSum / queryTokens.length;
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }

  if (a.length >= 3 && b.includes(a)) {
    return 0.9;
  }

  if (b.length >= 3 && a.includes(b)) {
    return 0.85;
  }

  if (a[0] === b[0] && (a.startsWith(b) || b.startsWith(a))) {
    return 0.75;
  }

  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) {
    return 0;
  }
  const similarity = 1 - distance / maxLen;
  return similarity >= 0.5 ? similarity : 0;
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

async function githubRequest<T>(
  env: Env,
  path: string,
  init?: Omit<RequestInit, "headers">
): Promise<T> {
  const base = env.GITHUB_API_BASE ?? "https://api.github.com";
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "discord-issue-bot",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function message(content: string): InteractionResponse {
  return messageResponse(content);
}

function messageResponse(content: string): InteractionResponse {
  return {
    type: DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content
    }
  };
}

function jsonResponse(payload: InteractionResponse): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" }
  });
}
