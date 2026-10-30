# Manage the Apps plugin

The plugin `aiblecampus` (named `aiblecampus-apps` before 0.50.0) has two distributions. `apps_plugin_status` reports which one is running as `distribution`. Its tools come from up to three MCP servers: `apps` (deployment), `files` (my files, Google, gallery), and `media` (image and video). A person receives only the servers their education turned on.

- `hub`: Claude Desktop receives it from the 에이블캠퍼스 hub plugin marketplace `aiblecampus`. When a person signs in to Claude Desktop with 에이블캠퍼스 login, Claude Desktop receives the marketplace from the hub and installs the plugin automatically. That installed copy carries an automatic Apps connection for the signed-in person. For this distribution, do not install the plugin from GitHub, a command line, or another application, and do not copy credentials from another application.
- `public`: Claude Code installs it from the public marketplace `aiblecampus-plugins` (GitHub `letsur-dev/aiblecampus-plugins`), with any Claude sign-in (Pro or Max subscription, API key, or an organization gateway). It has no automatic Apps connection; Apps tools use device login (`start_apps_login`). Follow "Public marketplace" below and ignore the Claude Desktop steps.

## Install or repair (hub)

For the `public` distribution, use "Public marketplace" below. First distinguish installation, enablement, and tools callable in this conversation. Call `apps_plugin_status` when available; a marketplace listing or a visible skill does not prove the tools are loaded. If it works, resume without reinstalling.

### Tools are missing

1. Ask the user to open Customize, then Plugins, then the Organization tab under Discover in Claude Desktop, and check whether `aiblecampus` from the `aiblecampus` marketplace is listed.
2. If the marketplace is not listed, Claude Desktop is not signed in with 에이블캠퍼스 or the computer setup is not finished. Tell the user to follow the setup tab of the 에이블캠퍼스 hub (https://hub.aible-campus.com/setup), sign in to Claude with 에이블캠퍼스, then completely quit Claude, including its system tray process, and restart it. Do not change administrator policy yourself.
3. If the plugin is listed but not installed (a user removed it earlier, and an automatically installed plugin that was removed stays removed), install it from that Organization tab.
4. After installation, completely quit Claude, including its system tray process, then restart it. In Cowork, return to the existing conversation and check `apps_plugin_status` and the deploy skill again. A new conversation is not required by the observed workflow.
5. In the Code tab, `/reload-plugins` did not load MCP into the existing conversation in the observed environment. Do not promise it will or loop on reload. If tools are absent, prepare the handoff below and have the user open a new Code conversation in the same project.

Once the user says installation is complete, check the actual callable tools again. Do not repeatedly claim that installation is impossible. If tools are still absent, distinguish installed-but-not-loaded from missing installation.

### Updates

For the `hub` distribution, Claude Desktop re-fetches the hub marketplace periodically and installs a newer plugin version on its own. Do not update the plugin manually. If `apps_plugin_status` still reports an older version than the one the user expects, ask the user to completely quit and restart Claude.

### Preserve the deployment request

Before asking for a restart or new conversation, provide a ready-to-paste handoff containing the actual project path, personal/team choice, education and team names, exact workspace UUID, new app or existing app ID/name/URL, and any validation/deployment already completed. Never replace a missing team with the personal default. Include this instruction: "Use this workspace for every scoped tool. First call apps_plugin_status; do not reinstall if it works. Validate and deploy the specified project, then verify the final URL."

If the project directory is writable, save the non-secret deployment intent as `.aiblecampus-deploy.json` in that project before handing off. Include `workspace`, `projectPath`, `mode`, `educationName`, `workspaceName`, the chosen education `educationId` for a new personal app, and optional `deploymentId`/`deploymentName`/`url`. Do not store tokens or secrets. Read it in the new conversation and reconcile it with the user's current explicit request. The current request wins; an ambiguous short request must not discard the stored target, and a stored education is used without asking again.

Installation authorization does not authorize removing project files, applications, credentials, or data. Preserve other plugins and marketplace entries.

## Public marketplace

- Install: in a conversation, `/plugin marketplace add letsur-dev/aiblecampus-plugins`, then `/plugin install aiblecampus@aiblecampus-plugins` (in a terminal, `claude plugin marketplace add` and `claude plugin install`). No environment variables are required.
- Update: in a terminal, `claude plugin marketplace update aiblecampus-plugins`, then `claude plugin update aiblecampus@aiblecampus-plugins` (or the `/plugin` screen). Restart Claude Code and confirm the version with `apps_plugin_status`.
- Renamed from `aiblecampus-apps`: after `claude plugin marketplace update aiblecampus-plugins`, Claude Code moves an installed `aiblecampus-apps` to `aiblecampus` through the marketplace `renames`. If `aiblecampus-apps@aiblecampus-plugins` is still listed as installed, install `aiblecampus@aiblecampus-plugins` and then uninstall the old one. Device login is kept.
- Apps tools (deployment, status, logs, the app AI key) need a 에이블캠퍼스 account and device login. Without an account, design (`frontend-design`), visual explanation (`eli5`), clarifying questions (`ask-questions-if-underspecified`), and local development still work; say so instead of repeating login.
- Uninstall only on an explicit request: `claude plugin uninstall aiblecampus@aiblecampus-plugins` (or the `/plugin` screen). Do not delete deployed apps or project data.

## Uninstall

For the `hub` distribution, only on an explicit uninstall request, remove `aiblecampus` in Claude Desktop under Customize, then Plugins. An automatically installed plugin that the user removed stays removed until it is installed again from the Organization tab. Do not delete deployed apps or project data. Verify that Claude Desktop no longer lists the plugin as installed.
