const {
  DISCORD_BOT_TOKEN,
  DISCORD_APPLICATION_ID,
  DISCORD_GUILD_ID
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID.");
  process.exit(1);
}

const commands = [
  {
    name: "issue-create",
    description: "Create an issue in the configured GitHub repository",
    options: [
      {
        type: 3,
        name: "title",
        description: "Issue title",
        required: true
      },
      {
        type: 3,
        name: "body",
        description: "Issue body",
        required: false
      },
      {
        type: 3,
        name: "labels",
        description: "Comma-separated labels (e.g. bug,triage)",
        required: false
      }
    ]
  },
  {
    name: "issue-search",
    description: "Search issues in the configured repository",
    options: [
      {
        type: 3,
        name: "query",
        description: "Search text or qualifiers",
        required: true
      },
      {
        type: 3,
        name: "state",
        description: "Issue state",
        required: false,
        choices: [
          { name: "open", value: "open" },
          { name: "closed", value: "closed" },
          { name: "all", value: "all" }
        ]
      },
      {
        type: 4,
        name: "limit",
        description: "Number of issues to return (1-10)",
        required: false,
        min_value: 1,
        max_value: 10
      }
    ]
  },
  {
    name: "issue-label",
    description: "Add, set, or remove labels on an issue",
    options: [
      {
        type: 4,
        name: "number",
        description: "Issue number",
        required: true,
        min_value: 1
      },
      {
        type: 3,
        name: "labels",
        description: "Comma-separated labels",
        required: true
      },
      {
        type: 3,
        name: "mode",
        description: "How to apply labels",
        required: false,
        choices: [
          { name: "add", value: "add" },
          { name: "set", value: "set" },
          { name: "remove", value: "remove" }
        ]
      }
    ]
  }
];

const baseUrl = DISCORD_GUILD_ID
  ? `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`;

const response = await fetch(baseUrl, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(commands)
});

if (!response.ok) {
  console.error("Failed to register commands:", response.status, await response.text());
  process.exit(1);
}

const body = await response.json();
console.log(`Registered ${body.length} command(s).`);
