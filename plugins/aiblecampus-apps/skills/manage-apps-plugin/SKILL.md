---
name: manage-apps-plugin
description: Install, update, repair, or uninstall the AibleCampus Apps plugin in Claude Desktop Cowork, Claude Code, or Codex when requested or when an Apps deployment cannot find its tools.
---

# Manage the Apps plugin

The official marketplace is https://github.com/letsur-dev/aiblecampus-plugins. The plugin name is `aiblecampus-apps`. Use the current provider's supported plugin manager; inspect its available commands before running them. Do not invent provider commands or copy credentials from another application.

## Install or repair

First distinguish installation, enablement, and tools callable in this conversation. Call `apps_plugin_status` when available. A successful call proves the running MCP version; a marketplace listing or a visible skill does not. If it works, resume without reinstalling. For a requested update, update only this plugin through the supported manager and check its running version.

### Claude Desktop Cowork

Claude Code installation does not install a Cowork plugin. Do not run CLI installation or Code slash commands for Cowork. When MCP is absent, give the user this tested Desktop procedure:

1. Click the name at the bottom left, then Settings, Plugins, Browse at the top right.
2. In the modal click the + on the right, Add from repository, and enter https://github.com/letsur-dev/aiblecampus-plugins.
3. Confirm the Apps plugin was added. Completely quit Claude, including its system tray process, then restart it.
4. Return to the existing Cowork conversation and check `apps_plugin_status` and the deploy skill again. A new conversation is not required by the observed workflow.

Once the user says installation is complete, check the actual callable tools again. Do not repeatedly claim they used Code instead or that installation is impossible. If tools are still absent, distinguish installed-but-not-loaded from missing installation.

### Claude Code

Use the available `claude plugin` CLI to add the official marketplace, install `aiblecampus-apps@aiblecampus-plugins`, and enable it. Inspect help for supported syntax. The user's installation request authorizes these steps; do not inspect unrelated company projects to prove trust.

After installation, check callable MCP tools. In the observed Code environment, `/reload-plugins` did not load MCP into the existing conversation. Do not promise it will or loop on reload. If tools are absent, prepare the handoff below and have the user open a new Code conversation in the same project. Do not require quitting the whole Desktop application for Code. If tools are already callable, continue immediately.

### Preserve the deployment request

Before asking for a restart or new conversation, provide a ready-to-paste handoff containing the actual project path, personal/team choice, education and team names, exact workspace UUID, new app or existing app ID/name/URL, and any validation/deployment already completed. Never replace a missing team with the personal default. Include this instruction: "Use this workspace for every scoped tool. First call apps_plugin_status; do not reinstall if it works. Validate and deploy the specified project, then verify the final URL."

If the project directory is writable, save the non-secret deployment intent as `.aiblecampus-deploy.json` in that project before handing off. Include `workspace`, `projectPath`, `mode`, `educationName`, `workspaceName`, and optional `deploymentId`/`deploymentName`/`url`. Do not store tokens or secrets. Read it in the new conversation and reconcile it with the user's current explicit request. The current request wins; an ambiguous short request must not discard the stored target.

### Codex

Use its supported plugin manager and reload mechanism. Do not prescribe Claude commands. If a new conversation is needed, use the same complete handoff and target-preservation rules.

Installation authorization does not authorize removing project files, applications, credentials, or data. Preserve other plugins and marketplace entries.

## Uninstall

Only on an explicit uninstall request, remove `aiblecampus-apps` using the provider's plugin manager. Remove its marketplace only if explicitly requested and no other installed plugins depend on it. Do not delete deployed apps or project data. Retain credentials unless credential revocation was separately requested. Verify that the provider no longer lists the plugin.
