---
name: manage-apps-plugin
description: Install, update, repair, or uninstall the AibleCampus Apps plugin in Claude Code or Codex when requested or when an Apps deployment cannot find its tools.
---

# Manage the Apps plugin

The official marketplace is https://github.com/letsur-dev/aiblecampus-plugins. The plugin name is `aiblecampus-apps`. Use the current provider's supported plugin manager; inspect its available commands before running them. Do not invent provider commands or copy credentials from another application.

## Install or repair

1. Check whether `apps_plugin_status` is callable. If it reports a working plugin, continue the original task without reinstalling.
2. If absent, register the official marketplace and install `aiblecampus-apps`. If installed but broken, update it first. Reinstall only this plugin if updating does not repair it.
3. In Claude Code, use `/reload-plugins` when supported to refresh both skills and MCP. `/reload-skills` does not reload MCP. If a user must run the command, provide one short instruction and continue after reload. In Codex, use the provider's available reload mechanism.
4. Verify `apps_plugin_status` in the active conversation. If reloading is unavailable, ask the user to open a new conversation in the same project and carry forward the original request. Do not repeat installation in a loop or require closing the entire application.
5. Resume `deploy-to-apps`. Authenticate only when required, validate before deploying, recover interrupted deployment status before retrying, and report the final URL.

Installation authorization does not authorize removing project files, applications, credentials, or data. Preserve other plugins and marketplace entries.

## Uninstall

Only on an explicit uninstall request, remove `aiblecampus-apps` using the provider's plugin manager. Remove its marketplace only if explicitly requested and no other installed plugins depend on it. Do not delete deployed apps or project data. Retain credentials unless credential revocation was separately requested. Verify that the provider no longer lists the plugin.
