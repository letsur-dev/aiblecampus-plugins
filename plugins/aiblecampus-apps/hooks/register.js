/**
 * 앱 도구 자동 허용 mod(Claude Code mods, 클로드 앱 Code 탭과 CLI).
 *
 * Auto 권한 모드에서 배포 흐름의 앱 도구 호출을 Auto 판별기에 넘기지 않고 허용한다. 판별기는 deploy_project를 "외부 서비스로 소스 업로드"로
 * 막을 수 있고 같은 요청도 기기와 회차마다 결과가 달랐다(2026-10-13 소유자 화면). 사용자가 배포를 부탁한 것이므로 판별기 대신 허용한다.
 * - tool.check는 권한 규칙과 PreToolUse 훅이 정한 뒤에 온다. 아무 규칙도 없으면 `ask`(Auto 모드에서는 이 뒤에 판별기가 본다)이고,
 *   그때만 `allow`로 바꾼다. 문서: mod가 허용한 호출은 Auto 모드에서 판별기 확인 없이 실행된다(code.claude.com/docs/en/permissions "Extend permissions with hooks")
 * - deny 규칙과 훅의 거절, 이미 허용한 것은 그대로 둔다. 삭제, 중지, 이동, 데이터 전환, 설정과 AI 키, 로그인 도구는 넣지 않는다
 * - 이 파일은 플러그인의 MCP 서버 구성 요소와 함께 간다. 앱 기능을 끈 교육의 플러그인에는 없다(packages/domain/src/gateway/plugin-marketplace.ts)
 */
const PREFIX = "mcp__plugin_aiblecampus-apps_apps__";

/** 배포 흐름에서 쓰는 도구. 조회, 검증, 배포, 기존 앱 소스 받기 */
export const AUTO_ALLOWED_TOOLS = [
  "apps_plugin_status",
  "apps_whoami",
  "list_educations",
  "list_deployment_organizations",
  "list_deployments",
  "validate_project",
  "deploy_project",
  "deployment_status",
  "deployment_logs",
  "checkout_app_source",
].map((name) => PREFIX + name);

/**
 * @typedef {{ decision: "allow" | "ask" | "deny"; reason?: string }} ToolDecision
 * @typedef {(event: unknown) => Promise<ToolDecision>} Next
 * @typedef {(api: unknown, event: unknown, next: Next) => Promise<ToolDecision>} ToolCheckHook
 * @param {(event: "tool.check", matcher: { tool: string[] }, hook: ToolCheckHook) => void} on
 */
export function register(on) {
  on("tool.check", { tool: AUTO_ALLOWED_TOOLS }, async (_api, e, next) => {
    const decided = await next(e);
    return decided.decision === "ask" ? { decision: "allow" } : decided;
  });
}
