/**
 * 에이블캠퍼스 자동 허용 mod(Claude Code mods, 클로드 앱 Code 탭과 CLI). 모든 교육의 플러그인에 들어간다(앱 기능과 관계없음).
 *
 * Auto 권한 모드의 판별기는 같은 요청도 기기와 회차마다 결과가 달랐다. 아래 두 가지를 판별기 대신 허용한다.
 * - tool.check는 권한 규칙과 PreToolUse 훅이 정한 뒤에 온다. 아무 규칙도 없으면 `ask`(Auto 모드에서는 이 뒤에 판별기가 본다)이고,
 *   그때만 `allow`로 바꾼다. 문서: mod가 허용한 호출은 Auto 모드에서 판별기 확인 없이 실행된다(code.claude.com/docs/en/permissions "Extend permissions with hooks")
 * - deny 규칙과 훅의 거절, 이미 허용한 것은 그대로 둔다
 *
 * 1) 앱 도구(2026-10-13 소유자 화면): 판별기는 deploy_project를 "외부 서비스로 소스 업로드"로 막을 수 있었다. 사용자가 배포를 부탁한 것이므로 허용한다.
 *    배포 흐름의 조회, 검증, 배포만 넣고 삭제, 중지, 이동, 데이터 전환, 설정과 AI 키, 로그인 도구는 넣지 않는다.
 *    접두사는 플러그인 이름(aiblecampus)과 서버 키(apps)에서 온다: mcp__plugin_<플러그인>_<서버>__<도구>. 이름이나 서버 키를 바꾸면 여기도 바꾼다(안 맞으면 허용 확인창이 뜬다).
 *    이 도구들은 앱 배포 묶음이 켜진 교육에만 있다(없는 교육에서는 matcher에 걸릴 호출이 없다)
 * 2) 공개 패키지 설치와 실행(2026-10-30 소유자 결정, 영상·AI Agent 교육): 판별기는 `npm i gsap hyperframes`와 `npx hyperframes`를 "외부 코드 내려받아 실행"으로
 *    막고, 승인한 뒤에도 거절하거나 같은 일을 다른 명령으로 하려 하면 다시 막았다. 참가자가 설치만 하면 되도록 아래 한 줄짜리 명령만 허용한다(isPublicPackageCommand).
 *    - npm install|i|add <이름[@버전]>..., npx [-y] <이름[@버전]> [인자...], pip|pip3|python -m pip install <이름[==버전]>..., uvx <이름[@버전]> [인자...]
 *    - 이름은 공개 레지스트리의 이름 모양(npm: @범위/이름)만이다. URL, git, GitHub 약식(user/repo), 경로, 별칭(npm:)은 모두 아니다
 *    - 옵션은 허용 목록에 있는 것만이다. -g/--global, --prefix, --registry, --index-url, --target, --user, -r, -e, sudo는 목록에 없다
 *    - 셸 연결과 치환(; && | $( ) ` 따옴표 리다이렉트), 환경변수 앞붙임, 여러 줄은 글자 집합에서 걸러 낸다. 끝의 `2>&1`만 허용한다
 *    - Bash 입력에 sandbox 해제나 허용 도메인 목록이 붙어 있으면 넣지 않는다. 세션 작업 폴더 안에서 실행할 때만 허용한다
 *    - 이 규칙 밖의 설치와 실행은 전과 같이 판별기가 본다. 임의 패키지의 코드 실행(postinstall, npx)을 허용하므로 범위를 넓히지 않는다
 */
const PREFIX = "mcp__plugin_aiblecampus_apps__";

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

const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:latest|[~^]?\d[0-9A-Za-z.+-]*))?$/;
const PIP_NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const PIP_SPEC = new RegExp(`^${PIP_NAME}(?:(?:==|~=)\\d[0-9A-Za-z.+_-]*)?$`);
const UVX_SPEC = new RegExp(`^${PIP_NAME}(?:@(?:latest|\\d[0-9A-Za-z.+_-]*)|(?:==|~=)\\d[0-9A-Za-z.+_-]*)?$`);
/** 공백으로 나뉜 한 줄에 들어갈 수 있는 글자. 따옴표, 셸 연결, 치환, 리다이렉트, 글롭, 줄바꿈, 역슬래시는 없다 */
const SAFE_COMMAND = /^[A-Za-z0-9@/._=:^~+ -]{1,400}$/;
const NPM_FLAGS = new Set(["--save", "-S", "--save-dev", "-D", "--save-exact", "-E", "--no-audit", "--no-fund", "--legacy-peer-deps", "--ignore-scripts", "--silent"]);
const PIP_FLAGS = new Set(["-q", "--quiet", "-U", "--upgrade", "--no-cache-dir", "--disable-pip-version-check"]);
const NPX_FLAGS = new Set(["-y", "--yes"]);
/** Bash 입력 중 이 키만 있으면 허용한다. dangerouslyDisableSandbox, allowed_domains 같은 키는 판별기가 본다 */
const BASH_INPUT_KEYS = new Set(["command", "description", "timeout", "run_in_background"]);

/**
 * 패키지가 실행할 때 받는 인자. 절대 경로, 홈, 상위 폴더, URL은 아니다
 * @param {string} token
 */
function isPlainArgument(token) {
  return !token.startsWith("/") && !token.startsWith("~") && !token.includes("..") && !token.includes("://");
}

/**
 * 옵션 | 이름 목록. 이름이 하나 이상이고 옵션은 허용 목록에 있는 것만이다
 * @param {string[]} tokens
 * @param {Set<string>} flags
 * @param {RegExp} spec
 */
function isInstallList(tokens, flags, spec) {
  let names = 0;
  for (const token of tokens) {
    if (token.startsWith("-")) {
      if (!flags.has(token)) return false;
    } else if (spec.test(token)) names += 1;
    else return false;
  }
  return names > 0;
}

/**
 * 공개 레지스트리에서 이름으로 설치하거나 실행하는 한 줄 명령인지.
 * @param {string} command
 */
export function isPublicPackageCommand(command) {
  // 끝의 `2>&1`(오류 출력 합치기)만 리다이렉트로 허용한다. Claude가 설치 명령 뒤에 자주 붙인다
  const text = command.trim().replace(/ +2>&1$/, "");
  if (!SAFE_COMMAND.test(text)) return false;
  const tokens = text.split(/ +/);
  const [program = "", ...rest] = tokens;
  if (program === "npm") return ["install", "i", "add"].includes(rest[0] ?? "") && isInstallList(rest.slice(1), NPM_FLAGS, NPM_SPEC);
  if (program === "npx" || program === "uvx") {
    const options = program === "npx" && NPX_FLAGS.has(rest[0] ?? "") ? 1 : 0;
    const name = rest[options] ?? "";
    return (program === "npx" ? NPM_SPEC : UVX_SPEC).test(name) && rest.slice(options + 1).every(isPlainArgument);
  }
  if (program === "pip" || program === "pip3") return rest[0] === "install" && isInstallList(rest.slice(1), PIP_FLAGS, PIP_SPEC);
  if (["python", "python3", "py"].includes(program)) return rest[0] === "-m" && rest[1] === "pip" && rest[2] === "install" && isInstallList(rest.slice(3), PIP_FLAGS, PIP_SPEC);
  return false;
}

/**
 * 폴더 경로 비교용. 역슬래시를 슬래시로, 끝 슬래시를 빼고 Windows 드라이브 경로는 소문자로
 * @param {string} folder
 */
function normalizeFolder(folder) {
  const slashed = folder.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * 실행 폴더가 세션 작업 폴더(root) 안인지. root가 파일 시스템 맨 위나 드라이브 맨 위면 아니다
 * @param {string} cwd
 * @param {string} root
 */
export function isInsideWorkingFolder(cwd, root) {
  const base = normalizeFolder(root);
  if (base === "" || /^[a-z]:$/i.test(base)) return false;
  const dir = normalizeFolder(cwd);
  return dir === base || dir.startsWith(`${base}/`);
}

/**
 * @typedef {{ decision: "allow" | "ask" | "deny"; reason?: string }} ToolDecision
 * @typedef {(event: unknown) => Promise<ToolDecision>} Next
 * @typedef {{ session: { cwd: () => Promise<string>; root: () => Promise<string> } }} ModApi
 * @typedef {{ tool: string; input?: unknown }} ToolCheckEvent
 * @typedef {(api: ModApi, event: ToolCheckEvent, next: Next) => Promise<ToolDecision>} ToolCheckHook
 * @param {(event: "tool.check", matcher: { tool: string | string[] }, hook: ToolCheckHook) => void} on
 */
export function register(on) {
  on("tool.check", { tool: AUTO_ALLOWED_TOOLS }, async (_api, e, next) => {
    const decided = await next(e);
    return decided.decision === "ask" ? { decision: "allow" } : decided;
  });
  on("tool.check", { tool: "Bash" }, async (api, e, next) => {
    const decided = await next(e);
    if (decided.decision !== "ask") return decided;
    const input = /** @type {Record<string, unknown> | null | undefined} */ (e.input);
    if (input === null || typeof input !== "object" || typeof input["command"] !== "string") return decided;
    if (!Object.keys(input).every((key) => BASH_INPUT_KEYS.has(key)) || !isPublicPackageCommand(input["command"])) return decided;
    try {
      if (!isInsideWorkingFolder(await api.session.cwd(), await api.session.root())) return decided;
    } catch {
      return decided;
    }
    return { decision: "allow", reason: "공개 레지스트리 패키지 설치와 실행" };
  });
}
