# Manage the Apps plugin

The official marketplace is https://github.com/letsur-dev/aiblecampus-plugins. The plugin name is `aiblecampus-apps`. Use the current provider's supported plugin manager; inspect its available commands before running them. Do not invent provider commands or copy credentials from another application.

## 공식 제품명

브랜드의 한국어 이름은 **에이블캠퍼스**, 이 제품의 공식 표기는 **에이블캠퍼스 Apps**다. 진행 설명, 최종 응답, 복사할 프롬프트, 새 세션용 인계문에서도 이 표기를 그대로 사용한다. 사용자의 입력이나 과거 대화에 오타가 있어도 제품명은 공식 표기로 바로잡는다. “아블캠퍼스”, “에이블캐퍼스”처럼 발음을 추정해 바꾸지 않는다. `aiblecampus-apps`, `.aiblecampus-deploy.json`, 도구 이름과 URL 등 기술 식별자는 원문을 유지한다.

## 응답 언어

사용자에게 보내는 모든 설명은 한국어로 작성한다. 작업 시작 안내, 도구 호출 전후 설명, 진행 상황, 빌드 실패 원인과 재시도 안내, 인증 안내, 질문, 최종 결과에 모두 적용한다. MCP 응답이나 빌드 로그가 영어여도 사용자에게는 한국어로 요약한다. 영어 로그를 그대로 이어 쓰거나 영어로 진행 상황을 설명하지 않는다. URL, 파일 경로, 명령어, 도구 이름, 제품명과 오류 코드는 정확한 원문을 유지한다. 클라이언트가 자동으로 표시하는 도구 실행 배지와 원본 로그의 언어는 이 스킬이 변경하지 못하므로, 별도의 설명을 한국어로 제공한다.

## Install or repair

First distinguish installation, enablement, and tools callable in this conversation. Call `apps_plugin_status` when available. A successful call proves the running MCP version; a marketplace listing or a visible skill does not. If it works, resume without reinstalling. For a requested update, update only this plugin through the supported manager and check its running version.

### Claude Desktop Cowork

Claude Code installation alone does not install a Cowork plugin. Managed third-party Desktop deployments may provision the official marketplace with `allowedPluginMarketplaces` and its MCP server with `managedMcpServers`. If `apps_plugin_status` works, do not ask for manual installation. A managed-device authentication failure requires the event operator to check that laptop registration; do not copy another runtime's credentials or start a different browser login as a fallback. Do not change administrator policy during an ordinary deployment request.

For an unmanaged Desktop with no callable MCP tools, give the user this tested procedure:

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
