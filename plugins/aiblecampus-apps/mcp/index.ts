import { appMeta, GALLERY_SECTION_MAX, GALLERY_SECTIONS, GALLERY_SUMMARY_MAX, galleryWriteup } from "./app-meta.ts";
import { DeletionConfirmations } from "./delete-confirmation.ts";
import { checkPublicAccess } from "./public-access.ts";
import { AiSetupError, configureAiGateway, verifyAiGateway } from "./ai-gateway.ts";
import { checkoutSnapshot, readSourceBase, saveSourceBase } from "./source-checkout.ts";
import { appsEnv } from "./config.ts";
import { HUB_CREDENTIAL_RENEW_NOTICE, hubCredential, rejectHubCredential, usableHubCredential } from "./hub-credential.ts";
import { pluginDistribution } from "./distribution.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packDirectory } from "./pack.ts";
import { loadSelectedLocalEnv } from "./local-env.ts";
import {
  completeDeviceLogin,
  deviceRequestHeaders,
  startDeviceLogin,
} from "./device-auth.ts";
import {
  backupAndSnapshotFiles,
  backupAndSnapshotSqlite,
  snapshotFiles,
  snapshotSqlite,
  withinProject,
} from "./persistence-migration.ts";
import { openVerificationUrl } from "./open-browser.ts";
import { deploymentAttempt } from "./deployment-attempts.ts";

/** 모든 api. 요청의 `X-Apps-Plugin-Version` 값. 서버가 일별로 기록해 갱신 현황을 본다 */
export const PLUGIN_VERSION = "0.40.1";
const deletionConfirmations = new DeletionConfirmations();

/**
 * Apps 접속 주소. APPS_API_URL, hub 자동 연결 파일(aiblecampus-credential.json)의 apiBase, 운영 주소 순이다
 */
function apiBase(): string {
  return appsEnv("API_URL") || hubCredential()?.apiBase || "https://api.aible-campus.com";
}

const TOKEN_MISSING =
  "Apps 기기 Credential이 없다.\n" +
  "start_apps_login 으로 로그인을 시작하고 표시된 주소와 코드로 승인한 뒤 complete_apps_login 을 실행한다.";

/** 배포 이름 후보를 만든다. 그대로 subdomain 이 되므로 DNS label 규칙에 맞게 정리한다. */
export function toDeploymentName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return normalized.length < 2 ? `app-${normalized}` : normalized;
}

/**
 * git 주소로 볼 수 있는 입력인지 본다.
 *
 * 사용자가 로컬 경로와 git 주소를 같은 인자에 넣기 때문에 필요하다.
 * 서버 쪽 판별과 같은 규칙이며, 플러그인은 폴더 밖을 참조할 수 없어 복제해 둔다.
 * 한쪽을 고치면 `src/source/provider.ts` 도 고친다.
 */
export function looksLikeGitUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/^(https?|git|ssh):\/\//.test(trimmed)) return true;
  if (/^[\w.-]+@[\w.-]+:.+/.test(trimmed)) return true;
  return false;
}

/** git 주소에서 배포 이름 후보를 뽑는다. 마지막 경로 조각에서 .git 을 뗀다. */
export function gitRepoNameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "app";
  return last.replace(/\.git$/, "") || "app";
}

type JsonRecord = Record<string, unknown>;

type ApiResult = {
  ok: boolean;
  status: number;
  body: JsonRecord | string;
};

function sortedEntries(values: Record<string, string>): Array<[string, string]> {
  return Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

// git 배포의 멱등 재사용 창. 커밋 내용을 fingerprint 에 넣을 수 없으므로,
// 응답이 끊긴 직후의 재시도만 같은 revision 으로 합치고 그 뒤 재배포는 새로
// 처리한다. tarball 은 내용 해시라 이 제한이 필요 없다.
const GIT_ATTEMPT_TTL_MS = 90 * 1000;

function deploymentFingerprint(input: {
  sourceBaseCommit?: string | undefined;
  organization?: string | undefined;
  source: string;
  name: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  resources?: { cpus: number; memoryMb: number } | undefined;
  workspace?: string | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        apiBase: apiBase(),
        source: input.source,
        name: input.name,
        env: sortedEntries(input.env),
        secrets: sortedEntries(input.secrets),
        resources: input.resources ?? null,
        workspace: input.workspace ?? null,
        organization: input.organization ?? null,
        sourceBaseCommit: input.sourceBaseCommit ?? null,
      }),
    )
    .digest("hex");
}

const WorkspaceInputSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "apps_whoami로 확인한 대상 공간(개인 또는 조)의 UUID 또는 slug. 생략하면 서버가 개인 공간으로 처리한다. 대상 공간이 불분명하면 추측하지 말고 사용자에게 묻는다. 조 대상을 요청받았으면 생략하거나 개인 공간으로 바꾸지 않는다. 한 작업의 모든 도구에 같은 값을 넣는다",
  );

const EnvironmentKeySchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "환경변수 키 형식이 올바르지 않다");

const LocalEnvInputSchema = z
  .object({
    file: z
      .string()
      .describe("프로젝트 루트의 실제 값 파일. .env 또는 .env.local 계열만 허용한다"),
    envKeys: z
      .array(EnvironmentKeySchema)
      .optional()
      .describe("파일에서 읽어 일반 설정으로 전달하도록 사용자가 승인한 키 이름"),
    secretKeys: z
      .array(EnvironmentKeySchema)
      .optional()
      .describe("파일에서 읽어 암호화 비밀값으로 전달하도록 사용자가 승인한 키 이름"),
  })
  .optional()
  .describe(
    "로컬 env 파일에서 승인한 키만 MCP 내부가 읽는다. 값은 Agent 응답과 도구 결과에 반환하지 않는다. 앱이 실제로 쓰고 사용자가 승인한 키만 넣는다. configure_ai_gateway가 돌려준 localEnv는 그대로 넣는다. git 주소에는 쓸 수 없다. 새로 받은 폴더에는 파일이 없을 수 있다",
  );

type LocalEnvInput = {
  file: string;
  envKeys?: string[] | undefined;
  secretKeys?: string[] | undefined;
};

function mergeConfigurationValues(
  direct: Record<string, string> | undefined,
  fromFile: Record<string, string>,
  kind: string,
): Record<string, string> {
  const merged = { ...(direct ?? {}) };
  for (const [key, value] of Object.entries(fromFile)) {
    if (merged[key] !== undefined) {
      throw new Error(`${kind} 키 ${key}가 도구 인자와 로컬 env 파일에 중복됐다`);
    }
    merged[key] = value;
  }
  return merged;
}

async function selectedLocalConfiguration(
  projectPath: string,
  localEnv: LocalEnvInput | undefined,
): Promise<{ env: Record<string, string>; secrets: Record<string, string> }> {
  if (localEnv === undefined) return { env: {}, secrets: {} };
  return loadSelectedLocalEnv(projectPath, {
    file: localEnv.file,
    envKeys: localEnv.envKeys ?? [],
    secretKeys: localEnv.secretKeys ?? [],
  });
}

function assertConfigurationSeparation(
  env: Record<string, string>,
  secrets: Record<string, string>,
): void {
  const overlap = Object.keys(env).find((key) => secrets[key] !== undefined);
  if (overlap !== undefined) {
    throw new Error(`같은 키를 일반 설정과 비밀값으로 함께 전달할 수 없다: ${overlap}`);
  }
}

/**
 * api. 요청. hub 자동 연결 Credential(Bearer amc_)이 있으면 먼저 쓰고, 401이면 이 프로세스에서 버린 뒤 기기 로그인 Credential(DPoP)로 한 번 다시 보낸다.
 * 401은 서버가 본문을 읽기 전에 거절한 것이라 다시 보내도 중복 처리가 없다. 둘 다 없으면 status 0과 로그인 안내다
 */
async function callApi(
  urlPath: string,
  init: RequestInit = {},
  workspace?: string,
): Promise<ApiResult> {
  const url = `${apiBase()}${urlPath}`;
  const hub = usableHubCredential(apiBase());
  if (hub !== null) {
    const result = await sendApi(url, init, workspace, async () => ({ authorization: `Bearer ${hub.token}` }));
    if (result?.status !== 401) return result!;
    rejectHubCredential(hub.token);
  }
  const result = await sendApi(url, init, workspace, () => deviceRequestHeaders(apiBase(), url, init.method ?? "GET"));
  if (result !== null) return result;
  // 자동 연결 파일이 있는데 쓸 수 없으면(만료, 해제, 다른 주소) 다시 로그인하면 자동 연결이 새로 된다고 알린다
  return { ok: false, status: 0, body: hubCredential() === null ? TOKEN_MISSING : `${HUB_CREDENTIAL_RENEW_NOTICE}\n${TOKEN_MISSING}` };
}

/** 인증 헤더를 붙여 한 번 보낸다. 인증이 없으면 null */
async function sendApi(
  url: string,
  init: RequestInit,
  workspace: string | undefined,
  authenticate: () => Promise<Record<string, string> | null>,
): Promise<ApiResult | null> {
  let response: Response;
  try {
    const authentication = await authenticate();
    if (authentication === null) return null;
    const headers = new Headers(init.headers);
    headers.set("x-apps-plugin-version", PLUGIN_VERSION);
    if (workspace !== undefined) headers.set("x-apps-workspace", workspace);
    for (const [key, value] of Object.entries(authentication)) {
      headers.set(key, value);
    }
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch (error) {
    // 네트워크 실패와 인증 실패를 구분해야 사용자가 고칠 곳을 안다.
    return {
      ok: false,
      status: 0,
      body:
        `Apps 에 연결하지 못했다: ${apiBase()}\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        "APPS_API_URL 이 올바른지, 플랫폼이 기동 중인지 확인한다.",
    };
  }

  const text = await response.text();
  let body: JsonRecord | string = text;
  try {
    body = JSON.parse(text) as JsonRecord;
  } catch {
    // 본문이 JSON 이 아니면 그대로 둔다
  }
  return { ok: response.ok, status: response.status, body };
}

function textResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function validatedProjectResult(
  source: "git" | "tarball",
  body: JsonRecord | string,
): ReturnType<typeof textResult> {
  if (typeof body === "string") {
    return textResult({ 검증됨: true, 소스: source, 응답: body });
  }
  const transitions = Array.isArray(body["transitions"])
    ? body["transitions"]
    : [];
  return textResult({
    검증됨: true,
    소스: source,
    ...body,
    ...(transitions.length === 0
      ? {}
      : {
          영속_전환_안내: {
            읽기_전용_진단: true,
            승인_필요: true,
            다음_단계: [
              "transitions의 현재 구성, 대상, 데이터 존재 여부, 위험과 검증 항목을 사용자에게 설명한다",
              "배포 요청과 별도로 영속 스택 전환 승인을 명시적으로 받는다",
              "기존 데이터가 있으면 원본을 보존한 백업과 실행 전 미리보기를 먼저 만든다",
              "승인한 범위만 변경하고 실패하면 원본과 백업을 그대로 둔다",
              "변경한 정확한 소스로 validate_project를 다시 호출한다",
            ],
          },
        }),
  });
}

function errorResult(message: string): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 서버가 이전 로그인 주소(auth.)에서 발급한 토큰을 거부했다는 응답 */
export const PLUGIN_UPDATE_REQUIRED_MESSAGE =
  "Apps 로그인 주소가 login.aible-campus.com으로 바뀌어 이전 기기 로그인은 더 쓸 수 없다.\n" +
  "start_apps_login으로 기기 로그인을 다시 진행한다. 계속 같은 오류가 나면 manage-apps-plugin 지침으로 플러그인을 최신 버전으로 갱신한다.";

export function isPluginUpdateRequired(result: Pick<ApiResult, "status" | "body">): boolean {
  return result.status === 401 && typeof result.body === "object" && result.body !== null && result.body["error"] === "plugin_update_required";
}

/** 실패 응답을 사람과 agent 가 함께 읽을 수 있는 형태로 만든다. */
function failure(prefix: string, result: ApiResult, hint?: string): ReturnType<typeof errorResult> {
  if (result.status === 0) return errorResult(String(result.body));
  if (isPluginUpdateRequired(result)) {
    return errorResult(`${prefix}: ${PLUGIN_UPDATE_REQUIRED_MESSAGE}`);
  }
  if (result.status === 401) {
    return errorResult(
      `${prefix}: 인증에 실패했다 (401).\nstart_apps_login으로 기기 로그인을 다시 진행한다.`,
    );
  }
  const next = hint ?? (result.status === 404 ? NOT_FOUND_HINT : undefined);
  return errorResult(
    `${prefix} (HTTP ${result.status})\n${
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2)
    }${next === undefined ? "" : `\n${next}`}`,
  );
}

const NOT_FOUND_HINT = "다른 공간의 앱인지 추측하지 않는다. 권한이 없거나 대상이 없다고만 설명한다";
const QUEUE_RETRY_HINT = "details.retryable이 true면 잠깐 기다린 뒤 한 번만 다시 시도한다. false면 다시 시도하지 않고, 기존 앱은 계속 제공되며 운영진의 용량 조치가 필요하다고 설명한다";
const TLS_NOT_READY_HINT = "인증서 준비 문제다. 코드나 메모리를 바꾸지 않고 deployment_status로 상태를 본다. 같은 요청을 다시 배포하지 않는다";

/** 배포 실패 응답의 stage와 details.code에 맞는 다음 행동 */
function deploymentFailureHint(body: ApiResult["body"]): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const details = typeof body.details === "object" && body.details !== null ? body.details : {};
  if ("code" in details && details.code === "public-tls-not-ready") return TLS_NOT_READY_HINT;
  if (body.stage === "queue") return QUEUE_RETRY_HINT;
  return undefined;
}

/**
 * 서버가 조원 변경을 자동으로 합쳐 배포했을 때(0.38.0, 결정 6) 에이전트에게 줄 안내. 응답의 sourceMerge는 본문에 그대로 남는다.
 * 배포한 코드에는 조원 변경이 들어 있지만 로컬 폴더에는 없다. 로컬 기준(.apps-source.json)은 업로드 원본 커밋이라 같은 폴더에서
 * 다시 배포해도 조원 변경을 지우지 않는다
 */
function mergeNotice(body: unknown): { 자동_병합?: string } {
  if (typeof body !== "object" || body === null || !("sourceMerge" in body)) return {};
  const merge = z.object({ files: z.array(z.string()), commits: z.array(z.object({ title: z.string() })) }).safeParse(body.sourceMerge);
  if (!merge.success) return {};
  const files = merge.data.files.slice(0, 20).join(", ") + (merge.data.files.length > 20 ? ` 외 ${merge.data.files.length - 20}개` : "");
  return {
    자동_병합: `작업을 시작한 뒤 조원이 먼저 배포한 변경(커밋 ${merge.data.commits.length}개, 파일 ${merge.data.files.length}개: ${files})을 서버가 충돌 없이 합쳐 함께 배포했다. ` +
      "로컬 폴더에는 이 변경이 없다. 사용자에게 합친 내용을 알린다. 이어서 같은 폴더에서 고쳐도 되지만, 합친 파일을 함께 고치거나 확인하려면 checkout_app_source로 최신 소스를 새 폴더에 받아 이어서 작업한다",
  };
}

/**
 * 소스 충돌은 같은 배포 요청 안에서 agent가 통합 후 복구한다.
 * 서버가 latestCommit(충돌을 판정한 기본 브랜치 커밋)을 주면 최신 소스를 그 커밋으로 받게 해 판정과 같은 코드에 통합한다(0.38.0).
 * changedSince(기준 뒤 커밋과 파일)는 응답 본문에 그대로 남는다
 */
async function deploymentFailure(result: ApiResult, deployment: string, workspace: string | undefined, sourceBaseCommit: string | undefined) {
  const body = result.body;
  if (result.status !== 409 || typeof body !== "object" || body === null ||
      typeof body.details !== "object" || body.details === null ||
      !("code" in body.details) || body.details.code !== "source-conflict") {
    return failure("배포에 실패했다", result, deploymentFailureHint(body));
  }
  const latest = "latestCommit" in body.details && typeof body.details.latestCommit === "string" && /^[a-f0-9]{40}$/.test(body.details.latestCommit)
    ? body.details.latestCommit
    : undefined;
  const workflowResult = await callApi("/v1/plugin-skills/deploy-to-apps", { signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" });
  const workflow = workflowResult.ok ? z.object({ schemaVersion: z.literal(1), skill: z.object({
    id: z.literal("deploy-to-apps"), content: z.string().min(1).max(100_000), version: z.number().int().positive(),
  }) }).safeParse(workflowResult.body) : null;
  return errorResult(JSON.stringify({
    ...body,
    recovery: {
      ...(workflow?.success ? { workflow: { id: workflow.data.skill.id, version: workflow.data.skill.version } } : {}),
      action: "merge_latest_validate_redeploy",
      deployment,
      workspace,
      sourceBaseCommit: sourceBaseCommit ?? null,
      latestSource: { tool: "checkout_app_source", arguments: { deployment, workspace, ...(latest === undefined ? {} : { commit: latest }) } },
      ...(sourceBaseCommit === undefined ? {} : {
        baseSource: { tool: "checkout_app_source", arguments: { deployment, workspace, commit: sourceBaseCommit } },
      }),
      instructions: [
        "기존 배포 요청이 유효하면 사용자에게 재시도를 맡기지 말고 이 복구를 계속 수행한다",
        "원본 작업 폴더와 변경을 보존한다. checkout_app_source의 directory에 각각 존재하지 않는 절대 경로를 지정해 최신 소스와 기준 소스를 별도 폴더로 받는다",
        "기준 소스와 자신의 작업을 비교한 변경만 최신 소스에 통합한다. 기준이 없으면 요청과 작업 이력으로 자신의 변경 범위를 확인하며 로컬 전체를 최신 폴더에 덮어쓰지 않는다",
        "같은 줄의 충돌도 양쪽 의도를 유지할 수 있으면 직접 해결한다. 서로 양립할 수 없는 요구사항이나 변경 범위를 확정할 수 없는 경우에만 사용자에게 판단을 요청한다",
        "최신 소스를 받은 폴더에 통합하고 그 폴더에서 기능과 빌드를 확인한다. validate_project를 통과한 뒤 그 폴더 경로와 같은 deployment 이름, workspace로 deploy_project를 호출한다. 기준 커밋은 그 폴더의 .apps-source.json에서 자동으로 보낸다. 기존 env, secrets, resources 설정 의도도 유지한다",
        ".apps-source.json의 기준 커밋을 고치거나 forceNewRevision으로 충돌을 우회하지 않는다. 다시 충돌하면 최신 소스로 같은 절차를 반복하되 연속 3회면 진행 상황과 동시 수정 상황을 보고한다",
      ],
    },
  }, null, 2));
}

const server = new McpServer({
  name: "aiblecampus-apps",
  version: PLUGIN_VERSION,
});

server.registerTool("get_plugin_skill", {
  title: "최신 Apps 스킬 지침 조회",
  description: "Apps 스킬 작업을 시작할 때 현재 게시된 세부 지침을 가져온다. Claude 데스크톱의 Cowork와 Code에서 동일하게 사용한다. 반환된 버전은 이번 작업에 사용하고 새 작업에서는 다시 조회한다. 설치 변경이나 배포는 수행하지 않는다.",
  // 원본 그대로 넣은 스킬(frontend-design, eli5, ask-questions-if-underspecified)은 원격 지침을 받지 않는다(0.39.1). 서버는 옛 플러그인을 위해 계속 받는다
  inputSchema: { skill: z.enum(["deploy-to-apps", "build-ai-feature", "manage-apps-plugin"]) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ skill }) => {
  const result = await callApi(`/v1/plugin-skills/${skill}`, { signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" });
  if (!result.ok) return errorResult(`최신 스킬을 조회하지 못했다 (상태 ${result.status}). 동봉된 references/bundled-workflow.md를 사용한다. 지침 조회만을 위해 로그인이나 설치 변경을 강제하지 않는다.`);
  const parsed = z.object({ schemaVersion: z.literal(1), skill: z.object({
    id: z.literal(skill), title: z.string(), content: z.string().min(1).max(100_000),
    version: z.number().int().positive(), updatedAt: z.string(),
  }) }).safeParse(result.body);
  return parsed.success ? textResult(parsed.data.skill) : errorResult("스킬 응답 형식이 호환되지 않는다. 동봉된 references/bundled-workflow.md를 사용한다.");
});

/**
 * 공개 마켓플레이스 설치(Claude Code, Claude 구독 로그인 등)에서 Apps 로그인이 없을 때의 get_ai_gateway 안내(0.40.1).
 * hub 설치(교육 참가자)는 외부 키를 권하지 않는 위 문구를 그대로 쓴다. 공개본 사용자는 에이블캠퍼스 계정이 없을 수 있어 막다른 길이 되지 않게 한다
 */
export const PUBLIC_AI_GATEWAY_UNAVAILABLE =
  "에이블캠퍼스 앱용 AI 환경을 쓰려면 Apps 로그인이 필요하다(공개 마켓플레이스 설치, 로그인 없음). " +
  "사용자가 에이블캠퍼스 교육 참가자이면 start_apps_login과 complete_apps_login으로 한 번 로그인한 뒤 다시 부른다. " +
  "계정이 없으면 로그인을 반복하지 않고 build-ai-feature 스킬의 \"앱용 AI 환경이 없을 때\" 절차로 진행한다: 사용자가 가진 AI 제공자 API 키를 Git에서 제외한 .env.local에 사용자가 직접 넣고 서버에서만 읽는다. " +
  "Claude 구독(Pro, Max) 로그인은 앱 서버가 부를 API 키가 아니다.";

server.registerTool("get_ai_gateway", {
  title: "산출물 AI 환경과 모델 확인",
  description: "AI로 요청하고 응답하는 기능, 챗봇, 요약 등 산출물 AI 기능 구현에 사용합니다. 교육 담당자가 허브(hub.aible-campus.com)에서 정한 앱용 AI 환경과 현재 모델 목록을 확인하며 API 키는 반환하지 않습니다. 지원 모델은 이 결과로 안내하고 고정 목록을 약속하지 않는다. 목록에 있어도 모든 API를 지원하지는 않으며 목록 확인은 실제 응답 검증이 아니다. 배포 대상이 없으면 workspace를 생략해 조회해도 되고 이 조회를 배포 대상 선택으로 기록하지 않는다.",
  inputSchema: { workspace: WorkspaceInputSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ workspace }) => {
  const result = await callApi("/v1/ai-gateway", { signal: AbortSignal.timeout(240_000), redirect: "error" }, workspace);
  if (!result.ok && pluginDistribution() === "public" && (result.status === 401 || (result.status === 0 && typeof result.body === "string" && result.body.includes(TOKEN_MISSING)))) {
    return errorResult(PUBLIC_AI_GATEWAY_UNAVAILABLE);
  }
  if (!result.ok) return errorResult(`산출물 AI 환경 조회에 실패했습니다 (상태 ${result.status}). 0 또는 401이면 Apps 로그인을 확인하고 403이면 workspace 권한, 503이면 운영 환경 연결을 확인하십시오. 모델 목록을 확인하지 못했다고 알리고, AI 연결 기능이 없다거나 외부 API 키를 직접 준비해야 한다고 안내하지 않는다.`);
  const parsed = z.object({ environment: z.object({ id: z.string().uuid(), name: z.string() }), baseUrl: z.literal("https://gw.letsur.ai/v1"), models: z.array(z.string()), documentationUrl: z.string() }).safeParse(result.body);
  return parsed.success ? textResult(parsed.data) : errorResult("AI 환경 응답 형식을 확인하지 못했습니다.");
});

server.registerTool("configure_ai_gateway", {
  title: "프로젝트에 산출물 AI 설정 연결",
  description: "AI 기능 구현을 위해 앱용 AI 환경의 최신 키를 MCP 내부에서 받아 프로젝트 .env.apps-ai에 저장합니다. 모델은 get_ai_gateway 결과에서 선택합니다. 키를 응답에 출력하지 않으며 배포하지 않습니다. 사용자에게 API 키나 운영 화면 정보를 받지 않는다. 새로 받은 폴더이거나 운영진이 키를 바꾼 뒤에는 다시 부른다. 결과의 localEnv를 validate_project와 deploy_project에 그대로 넣는다. Claude 데스크톱 자체 게이트웨이 설정은 바꾸지 않는다.",
  inputSchema: { path: z.string().min(1), model: z.string().min(1).max(200), workspace: WorkspaceInputSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ path: projectPath, model, workspace }) => {
  try {
    const result = await callApi("/v1/ai-gateway/configuration", { method: "POST", signal: AbortSignal.timeout(240_000), redirect: "error" }, workspace);
    if (!result.ok) return errorResult(`산출물 AI 설정을 가져오지 못했습니다 (상태 ${result.status}). 0 또는 401이면 Apps 로그인을 확인하고 403이면 workspace 권한, 503이면 운영 환경 연결을 확인하십시오.`);
    return textResult(await configureAiGateway(projectPath, model, result.body));
  } catch (error) { if (error instanceof AiSetupError) return errorResult(error.message); return errorResult("AI 설정을 저장하지 못했습니다. 프로젝트 경로, 기존 .env.apps-ai와 .gitignore의 파일 소유 및 잠금 상태를 확인하십시오. 기존 파일 내용을 대화에 출력하지 마십시오."); }
});

server.registerTool("verify_ai_gateway", {
  title: "산출물 AI 요청과 응답 검증",
  description: "프로젝트 .env.apps-ai를 내부에서 읽어 짧은 실제 AI 요청을 한 번 보냅니다. 소량의 사용량이 발생합니다. 키와 응답 원문은 출력하지 않습니다. 산출물 서버 통합 검증이나 배포를 대신하지 않습니다.",
  inputSchema: { path: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ path: projectPath }) => {
  try { return textResult(await verifyAiGateway(projectPath)); }
  catch { return errorResult("AI 연결 검증을 완료하지 못했습니다. .env.apps-ai 설정과 네트워크를 확인하십시오. 자동 재시도는 수행하지 않았습니다."); }
});

server.registerTool(
  "start_apps_login",
  {
    title: "Apps 기기 로그인 시작",
    description: "Identity에서 기기별 로그인 코드와 승인 주소를 발급하고 원문 device code는 로컬 보호 파일에만 저장한다. apps_plugin_status의 authenticationMode가 device-login이고 인증이 없을 때만 부른다. 다른 계정이나 다른 앱의 자격 증명으로 대신하지 않는다.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const login = await startDeviceLogin(apiBase());
      const approvalUrl = login.verificationUriComplete ?? login.verificationUri;
      const browserOpened = await openVerificationUrl(approvalUrl);
      return textResult({
        ...login,
        browserOpened,
        nextAction: browserOpened
          ? "브라우저에서 승인하는 동안 complete_apps_login을 바로 호출해 polling한다"
          : "승인 주소를 사용자에게 보여준 뒤 complete_apps_login을 바로 호출해 polling한다",
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "complete_apps_login",
  {
    title: "Apps 기기 로그인 완료",
    description: "사용자 승인 상태를 Identity 표준 polling 간격에 맞춰 확인하고 성공하면 이 기기의 Credential을 0600 로컬 파일에 저장한다. pending이나 polling_limit이면 새 로그인을 시작하지 않고 이 도구를 다시 불러 같은 요청을 이어간다. 성공하면 원래 요청을 다시 묻지 않고 이어간다.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      return textResult(await completeDeviceLogin(apiBase()));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "validate_project",
  {
    title: "프로젝트 배포 전 검증",
    description:
      "프로젝트를 빌드하거나 실행하지 않고 배포 가능 여부를 판정한다. runtime, 프레임워크, 실행 명령, PORT와 bind, 환경변수, PostgreSQL과 파일 Storage 요구, Dockerfile 위험을 구조화해 반환한다. deployable이 false면 issues의 path, message, fix로 코드를 고치고 다시 검증한다. 소스를 고치면 이전 결과를 다시 쓰지 않는다. warning은 배포를 막지 않으며 보안, 데이터 손실, 주요 기능에 영향이 있을 때만 사용자에게 알린다. 요청 기능을 빼거나 검사를 피해서 통과시키지 않는다. 컨테이너 실행 검증을 대신하지 않는다.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "검증할 프로젝트의 로컬 디렉토리 절대 경로이거나 public git 저장소의 https 주소다. package.json이나 index.html이 있는 루트를 쓴다. 커밋하지 않은 변경이나 private 저장소는 로컬 경로로 검증한다. git 주소는 가능하면 고정한 commit이나 tag를 ref로 준다",
        ),
      ref: z
        .string()
        .optional()
        .describe("git 주소일 때만 쓰는 branch 나 tag 이름"),
      subdir: z
        .string()
        .optional()
        .describe("git 저장소 안에서 검증할 하위 디렉토리"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("배포할 때 주입할 일반 환경변수. 필요한 키 누락 판정에 사용한다"),
      secretKeys: z
        .array(z.string())
        .optional()
        .describe("비밀값으로 주입할 환경변수 키 이름. 값은 검증 도구에 넘기지 않는다"),
      localEnv: LocalEnvInputSchema,
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ path: projectPath, ref, subdir, env, secretKeys, localEnv, workspace }) => {
    if (looksLikeGitUrl(projectPath)) {
      if (localEnv !== undefined) {
        return errorResult("localEnv는 로컬 프로젝트 경로를 검증할 때만 사용할 수 있다");
      }
      const result = await callApi("/v1/preflight/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: projectPath,
          ...(ref === undefined ? {} : { ref }),
          ...(subdir === undefined ? {} : { subdir }),
          env: env ?? {},
          secretKeys: secretKeys ?? [],
        }),
      }, workspace);
      if (!result.ok) return failure("배포 전 검증에 실패했다", result);
      return validatedProjectResult("git", result.body);
    }

    if (!existsSync(projectPath)) {
      return errorResult(`경로가 없다: ${projectPath}`);
    }

    let resolvedEnv: Record<string, string>;
    let resolvedSecretKeys: string[];
    try {
      const local = await selectedLocalConfiguration(projectPath, localEnv);
      resolvedEnv = mergeConfigurationValues(env, local.env, "일반 설정");
      resolvedSecretKeys = [...new Set([...(secretKeys ?? []), ...Object.keys(local.secrets)])];
      assertConfigurationSeparation(
        resolvedEnv,
        Object.fromEntries(resolvedSecretKeys.map((key) => [key, "provided"])),
      );
    } catch (error) {
      return errorResult(
        `로컬 환경 설정을 준비하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let tarball: Buffer;
    try {
      tarball = await packDirectory(projectPath);
    } catch (error) {
      return errorResult(
        `소스를 묶지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const form = new FormData();
    form.set(
      "source",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      "source.tar.gz",
    );
    if (Object.keys(resolvedEnv).length > 0) {
      form.set("env", JSON.stringify(resolvedEnv));
    }
    if (resolvedSecretKeys.length > 0) {
      form.set("secretKeys", JSON.stringify(resolvedSecretKeys));
    }

    const result = await callApi("/v1/preflight", {
      method: "POST",
      body: form,
    }, workspace);
    if (!result.ok) return failure("배포 전 검증에 실패했다", result);
    return validatedProjectResult("tarball", result.body);
  },
);

server.registerTool(
  "deploy_project",
  {
    title: "프로젝트 배포",
    description:
      "프로젝트를 에이블캠퍼스 Apps 에 배포한다. 로컬 디렉토리 경로를 주면 tar.gz 로 묶어 올리고, git 주소를 주면 서버가 직접 clone 한다. 빌드와 실행, 접속 URL 발급까지 수행한다. 새 앱에는 displayName을, 모든 배포에는 changeSummary를 에이전트가 프로젝트 내용과 대화 맥락으로 한국어로 지어 함께 보낸다(사용자에게 묻지 않는다). 교육 앱이면 갤러리 설명 gallery도 같은 방법으로 써서 보낸다. validate_project를 통과한 뒤 고치지 않은 같은 소스를 보낸다. 빌드와 healthcheck가 끝날 때까지 기다리고 결과의 url을 그대로 안내하며 주소를 조립하지 않는다. 응답이 끊기거나 시간이 지나면 다시 부르기 전에 deployment_status로 기존 작업을 확인한다. 결과의 gallerySubmission이 unpublished면 message의 갤러리 제출 페이지에서 이 앱을 고르면 된다고 알린다. 로컬 경로의 .env와 .env.* 파일도 소스 압축에 포함된다(교육 설계상 의도). 참가자가 물으면 의도된 동작이라고 답한다. 배포할 때 소스 루트의 .env.production.local, .env.local, .env.production, .env 값은 앱 비밀값으로 자동 등록된다(앞 파일 우선). 배포 요청의 env, secrets, localEnv와 이미 저장된 설정이 먼저이고 파일은 없는 키만 더하며, PORT, NODE_ENV, DATABASE_URL, APPS_ 접두 키는 등록하지 않는다. 정적 앱은 .env 같은 점 파일을 브라우저에 주지 않는다(404). 결과의 envFiles.registered에 키가 있으면 자동 등록한 키 이름만 사용자에게 알리고 값은 말하지 않는다. envFiles.kept의 키는 이미 저장된 값을 썼으므로, 파일 값으로 바꾸려면 localEnv로 그 키를 보내거나 set_deployment_config로 고친다.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "배포할 프로젝트의 위치. 로컬 디렉토리의 절대 경로(보통 현재 작업 디렉토리)이거나 public git 저장소의 https 주소다. package.json이나 index.html이 있는 루트. 커밋하지 않은 변경이나 private 저장소는 로컬 경로를 쓴다. git 주소는 원격에 올라간 내용만 배포된다",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "관리용 프로젝트 이름(영문 소문자, 숫자, 하이픈). 화면에 보이는 앱 이름은 displayName이다. 개인 앱은 생략하면 디렉토리 이름에서 만든다. 조는 기존 앱 하나를 자동 갱신하며 이름이나 주소를 다시 정하지 않는다. 개인 앱도 같은 이름이면 그 앱을 갱신해 주소를 유지한다. 이름 충돌이 아니면 이름을 바꾸지 않는다",
        ),
      displayName: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .optional()
        .describe(
          "화면에 보이는 앱 이름. 한국어로 짧게(2-20자 권장, 60자 이하) 앱이 하는 일을 드러내게 짓는다. 예: 품질 불량 분류기, 설비 점검 기록장. 폴더 이름이나 slug 같은 형식 이름을 그대로 쓰지 않는다. 사용자가 이름을 말했으면 그 이름을 쓴다. 새 앱과 아직 표시 이름이 없는 앱에만 적용되고 기존 이름은 renameApp이 true일 때만 바뀐다",
        ),
      renameApp: z
        .boolean()
        .optional()
        .describe("사용자가 기존 앱의 이름을 바꿔 달라고 했을 때만 true. 그때 displayName으로 이름을 바꾼다. 평소 재배포에는 생략한다"),
      changeSummary: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "이번 배포에서 바뀐 점을 한국어 한 줄(120자 이하 권장)로 적은 버전 설명. 배포 기록에 보인다. 첫 배포는 앱이 하는 일을, 재배포는 이번에 달라진 기능이나 화면을 적는다. \"수정\", \"업데이트\"처럼 내용 없는 말이나 파일 목록, 커밋 해시를 쓰지 않는다. 충돌 복구나 실패 뒤 같은 변경을 다시 보낼 때는 같은 설명을 쓴다. 내부 ID, 비밀값, 개인정보를 쓰지 않는다",
        ),
      gallery: z
        .object({
          summary: z
            .string()
            .max(GALLERY_SUMMARY_MAX)
            .optional()
            .describe(`갤러리 카드에 보이는 요약 한 줄(${GALLERY_SUMMARY_MAX}자 이하). 앱이 누구의 어떤 일을 돕는지 적는다`),
          sections: z
            .object(
              Object.fromEntries(
                GALLERY_SECTIONS.map(({ key, label, hint }) => [key, z.string().max(GALLERY_SECTION_MAX).optional().describe(`${label}: ${hint} 마크다운 2-6줄(${GALLERY_SECTION_MAX}자 이하)`)]),
              ) as Record<(typeof GALLERY_SECTIONS)[number]["key"], z.ZodOptional<z.ZodString>>,
            )
            .optional()
            .describe("섹션별 마크다운 설명. 아는 칸만 채우고 모르는 칸은 비운다"),
        })
        .optional()
        .describe(
          "교육 갤러리에 올라갈 설명. 허브 갤러리 제출 페이지에서 이 앱을 고르면 제출물의 요약과 본문이 되고, 갤러리에 낸 앱을 다시 올리면 이 값으로 바뀐다(참가자가 웹에서 설명을 고쳤으면 그대로 두고 참가자가 바꿀지 고른다). 갤러리에 내는 것은 이 도구로 하지 않는다. 에이전트가 프로젝트 내용(README, 화면, 코드)과 대화 맥락으로 한국어로 써서 보낸다(사용자에게 묻지 않는다). 비밀값, 개인정보, 고객 실명은 쓰지 않고 확인하지 않은 효과나 수치를 지어내지 않는다. 예시 자료로 만든 앱이면 그렇다고 밝힌다. 교육 앱이 아니면 생략한다",
        ),
      ref: z
        .string()
        .optional()
        .describe("git 주소일 때만 쓴다. branch 나 tag 이름. 생략하면 기본 branch"),
      subdir: z
        .string()
        .optional()
        .describe(
          "git 주소일 때만 쓴다. 저장소 안에서 배포할 하위 디렉토리. monorepo 에서 쓴다",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("배포 컨테이너에 주입할 공개해도 되는 일반 설정(기능 플래그, 공개 기준 URL 등). PORT, DATABASE_URL, APPS_로 시작하는 값은 플랫폼이 넣으므로 넣지 않는다"),
      secrets: z
        .record(z.string(), z.string().min(1))
        .optional()
        .describe(
          "배포 컨테이너에 안전하게 주입할 비밀값. 응답과 로그에는 값이 표시되지 않는다. API 키, 비밀번호, 접속 Credential. 분류가 불분명하면 비밀값으로 넣는다",
        ),
      localEnv: LocalEnvInputSchema,
      resources: z
        .object({
          cpus: z.number().positive(),
          memoryMb: z.number().int().min(64),
        })
        .optional()
        .describe(
          "프로젝트에 적용할 CPU 수와 메모리 MB. 생략하면 플랫폼 기본값을 사용하며 운영 상한을 넘으면 배포가 거부된다. 사용자가 요구했거나 build 로그가 exit 137이나 메모리 부족을 보일 때만 지정하고 메모리는 상한 안에서 한 번만 올린다",
        ),
      forceNewRevision: z
        .boolean()
        .optional()
        .describe(
          "같은 소스와 설정의 직전 요청이 명확히 실패했고 새 빌드가 필요할 때만 true. 응답 단절 복구에는 사용하지 않는다. 한 번만 쓴다",
        ),
      education: z.string().optional().describe("새 개인 앱을 배포할 교육 ID(list_educations의 id). 배포할 수 있는 교육이 둘 이상이면 list_educations 목록을 사용자에게 보여 주고 고른 교육을 넣는다. 하나뿐이면 참가자는 생략하고, 운영진은 그 교육을 넣는다. education-required로 거절되면 응답의 교육 목록에서 고르게 한다. 기존 앱 재배포와 조 앱은 앱과 조의 교육을 따르므로 생략한다. 요청이나 .aiblecampus-deploy.json에 정해진 교육이 있으면 그 교육을 쓴다. 운영진은 apps_whoami의 canManagePluginSettings가 true인 계정이다"),
      organization: z.string().optional().describe("이전 클라이언트 호환 필드. 새 호출에서는 생략하고 교육은 education으로 지정한다"),
      workspace: z.string().min(1).describe("apps_whoami로 확인한 대상 공간(개인 또는 조)의 UUID 또는 slug. 요청과 프로젝트의 .aiblecampus-deploy.json을 확인한다. 대상 공간이 불분명하면 추측하지 말고 \"개인 산출물 배포\"와 \"조 산출물 배포(조 이름)\" 중 무엇인지 사용자에게 묻는다. 조 대상을 요청받았으면 개인 공간으로 바꾸지 않는다"),
      newApp: z
        .boolean()
        .optional()
        .describe("이미 다른 앱으로 배포한 폴더를 다른 이름의 새 앱으로 배포할 때만 true. 같은 이름 앱이 있다는 오류에서 사용자가 '다른 이름의 새 앱'을 고른 경우에만 쓰고 새 name을 함께 넣는다. 그 이름의 앱이 이미 있으면 배포하지 않는다. 폴더를 복사해 우회하지 않는다"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    path: projectPath,
    name,
    ref,
    subdir,
    env,
    secrets,
    localEnv,
    resources,
    forceNewRevision,
    workspace,
    education,
    organization: legacyOrganization,
    displayName,
    renameApp,
    changeSummary,
    gallery,
    newApp,
  }) => {
    const writeup = galleryWriteup(gallery);
    if (education && legacyOrganization && education !== legacyOrganization) return errorResult("교육은 한 번만 지정한다");
    const organization = education ?? legacyOrganization;
    // git 주소면 서버가 직접 clone 한다. 업로드가 없어 큰 저장소에서 훨씬 빠르다.
    if (looksLikeGitUrl(projectPath)) {
      if (localEnv !== undefined) {
        return errorResult("localEnv는 로컬 프로젝트 경로를 배포할 때만 사용할 수 있다");
      }
      const deploymentName = toDeploymentName(
        name ?? gitRepoNameOf(projectPath),
      );
      let attempt: { key: string; recovered: boolean };
      try {
        attempt = await deploymentAttempt(
          deploymentFingerprint({
            source: JSON.stringify({
              url: projectPath,
              ref: ref ?? null,
              subdir: subdir ?? null,
            }),
            name: deploymentName,
          organization,
            env: env ?? {},
            secrets: secrets ?? {},
            resources,
            workspace,
          }),
          forceNewRevision ?? false,
          // git 소스는 fingerprint 에 커밋 내용이 없어, 같은 branch 에 새 커밋을
          // push 하고 다시 배포해도 fingerprint 가 같다. 기본 30분 재사용을 두면
          // 새 커밋 배포가 조용히 무시되므로, 응답 단절 복구만 덮는 짧은 창을 쓴다.
          { ttlMs: GIT_ATTEMPT_TTL_MS },
        );
      } catch (error) {
        return errorResult(
          `배포 요청을 안전하게 준비하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const result = await callApi("/v1/deployments/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: deploymentName,
          organization,
          url: projectPath,
          ...(ref === undefined ? {} : { ref }),
          ...(subdir === undefined ? {} : { subdir }),
          env: env ?? {},
          ...(secrets === undefined ? {} : { secrets }),
          ...(resources === undefined ? {} : { resources }),
          idempotencyKey: attempt.key,
          ...appMeta({ displayName, renameApp, changeSummary }),
          ...(writeup === undefined ? {} : { gallery: writeup }),
        }),
      }, workspace);
      if (!result.ok) return deploymentFailure(result, deploymentName, workspace, undefined);
      return textResult({
        배포됨: true,
        기존_요청_복구: attempt.recovered,
        이름: typeof result.body === "object" && result.body !== null && "name" in result.body ? result.body.name : deploymentName,
        소스: "git",
        ...await checkPublicAccess(result.body),
        ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
      });
    }

    if (!existsSync(projectPath)) {
      return errorResult(`경로가 없다: ${projectPath}`);
    }

    let resolvedEnv: Record<string, string>;
    let resolvedSecrets: Record<string, string>;
    try {
      const local = await selectedLocalConfiguration(projectPath, localEnv);
      resolvedEnv = mergeConfigurationValues(env, local.env, "일반 설정");
      resolvedSecrets = mergeConfigurationValues(secrets, local.secrets, "비밀값");
      assertConfigurationSeparation(resolvedEnv, resolvedSecrets);
    } catch (error) {
      return errorResult(
        `로컬 환경 설정을 준비하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const deploymentName = toDeploymentName(name ?? path.basename(projectPath));

    // 기준 커밋은 checkout_app_source나 직전 배포가 프로젝트 폴더에 남긴 .apps-source.json에서만 읽는다(0.38.0).
    // 도구 입력으로 받으면 기준 값만 바꿔 조원 변경을 덮어쓸 수 있었다(2026-09 교육 D)
    let base: string | undefined;
    try { base = await readSourceBase(projectPath, apiBase(), deploymentName, workspace, newApp === true); }
    catch (error) { return errorResult(error instanceof Error ? error.message : "소스 기준을 확인하지 못했다"); }
    if (newApp === true) {
      // 새 앱이라고 했는데 그 이름의 앱이 있으면 그 앱을 갱신하게 된다. 덮어쓰지 않고 다른 이름을 받게 한다
      const existing = await callApi(`/v1/deployments/${encodeURIComponent(deploymentName)}`, {}, workspace);
      if (existing.ok) return errorResult(`이 공간에 '${deploymentName}' 앱이 이미 있습니다. 배포하지 않았습니다. 새 앱이면 사용자에게 다른 이름을 받아 다시 배포하고, 그 앱을 갱신하려면 newApp 없이 배포합니다.`);
      if (existing.status !== 404) return failure("같은 이름 앱이 있는지 확인하지 못했다. 배포하지 않았다", existing);
    }

    let tarball: Buffer;
    try {
      tarball = await packDirectory(projectPath);
    } catch (error) {
      return errorResult(
        `소스를 묶지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const form = new FormData();
    form.set("name", deploymentName);
    if (organization !== undefined) form.set("organization", organization);
    if (base !== undefined) form.set("sourceBaseCommit", base);
    form.set(
      "source",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      "source.tar.gz",
    );
    if (Object.keys(resolvedEnv).length > 0) {
      form.set("env", JSON.stringify(resolvedEnv));
    }
    if (Object.keys(resolvedSecrets).length > 0) {
      form.set("secrets", JSON.stringify(resolvedSecrets));
    }
    if (resources !== undefined) {
      form.set("resources", JSON.stringify(resources));
    }
    for (const [key, value] of Object.entries(appMeta({ displayName, renameApp, changeSummary }))) form.set(key, String(value));
    if (writeup !== undefined) form.set("gallery", JSON.stringify(writeup));
    let attempt: { key: string; recovered: boolean };
    try {
      attempt = await deploymentAttempt(
        deploymentFingerprint({
          source: createHash("sha256").update(tarball).digest("hex"),
          name: deploymentName,
          organization,
          sourceBaseCommit: base,
          env: resolvedEnv,
          secrets: resolvedSecrets,
          resources,
          workspace,
        }),
        forceNewRevision ?? false,
      );
    } catch (error) {
      return errorResult(
        `배포 요청을 안전하게 준비하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    form.set("idempotencyKey", attempt.key);

    const result = await callApi("/v1/deployments", {
      method: "POST",
      body: form,
    }, workspace);

    // 실패 단계와 원인을 그대로 전달해야 agent 가 다음 행동을 판단할 수 있다.
    if (!result.ok) return deploymentFailure(result, deploymentName, workspace, base);

    const committed = typeof result.body === "object" && result.body !== null ? (result.body as { sourceCommit?: unknown }).sourceCommit : null;
    if (typeof committed === "string") {
      try { await saveSourceBase(projectPath, apiBase(), deploymentName, workspace, committed); }
      catch { return textResult({ 배포됨: true, sourceCommit: committed, 안내: "배포는 완료됐으나 로컬 소스 기준을 기록하지 못했다. 다음 배포 전에 최신 소스를 확인한다", 결과: result.body }); }
    }

    return textResult({
      배포됨: true,
      기존_요청_복구: attempt.recovered,
      ...await checkPublicAccess(result.body),
      이름: typeof result.body === "object" && result.body !== null && "name" in result.body ? result.body.name : deploymentName,
      ...mergeNotice(result.body),
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
  },
);

server.registerTool(
  "preview_sqlite_transition",
  {
    title: "SQLite 이전 미리보기",
    description:
      "SQLite 원본을 변경하지 않고 table, 행 수와 checksum을 확인한다. 사용자 승인 전 단계에서만 사용한다.",
    inputSchema: {
      projectRoot: z.string().describe("확인 기준이 되는 프로젝트 루트 절대 경로"),
      databasePath: z.string().describe("프로젝트 안 SQLite 파일의 절대 경로"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ projectRoot, databasePath }) => {
    try {
      const snapshot = await snapshotSqlite(withinProject(projectRoot, databasePath));
      return textResult({
        읽기_전용_미리보기: true,
        sourceSha256: snapshot.sourceSha256,
        totalRows: snapshot.totalRows,
        tables: snapshot.tables.map((table) => ({
          name: table.name,
          rows: table.rows.length,
          checksum: table.checksum,
        })),
        다음_단계:
          "전환 대상, 코드 변경, 백업 위치와 검증 방법을 설명하고 사용자 승인을 받은 뒤 migrate_sqlite_data를 호출한다",
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "migrate_sqlite_data",
  {
    title: "승인된 SQLite 데이터 이전",
    description:
      "명시적 사용자 승인 뒤 SQLite 일관 백업을 만들고 이미 생성된 Apps PostgreSQL binding으로 데이터를 이전한다. 앱의 ORM migration으로 빈 PostgreSQL schema를 만든 배포에만 쓴다. table 100개, table당 100,000행까지이고 대상에 데이터가 있으면 거부한다.",
    inputSchema: {
      projectRoot: z.string().describe("백업을 보관할 프로젝트 루트 절대 경로"),
      databasePath: z.string().describe("프로젝트 안 SQLite 파일의 절대 경로"),
      deployment: z.string().describe("PostgreSQL binding이 연결된 배포 이름 또는 id"),
      approved: z.literal(true).describe("사용자가 데이터 이전을 명시적으로 승인했을 때만 true"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ projectRoot, databasePath, deployment, approved, workspace }) => {
    try {
      const prepared = await backupAndSnapshotSqlite(projectRoot, databasePath);
      const result = await callApi(
        `/v1/deployments/${encodeURIComponent(deployment)}/persistence/sqlite-import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved, snapshot: prepared.snapshot }),
        },
        workspace,
      );
      if (!result.ok) {
        return errorResult(
          `SQLite 이전에 실패했다. 원본과 백업은 유지했다: ${prepared.backupPath}\n${
            typeof result.body === "string"
              ? result.body
              : JSON.stringify(result.body, null, 2)
          }`,
        );
      }
      return textResult({
        이전됨: true,
        backupPath: prepared.backupPath,
        sourceSha256: prepared.snapshot.sourceSha256,
        ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "preview_local_files_transition",
  {
    title: "로컬 파일 이전 미리보기",
    description:
      "로컬 파일을 변경하지 않고 파일 수, 전체 크기와 checksum을 확인한다. 사용자 승인 전 단계에서만 사용한다.",
    inputSchema: {
      projectRoot: z.string().describe("확인 기준이 되는 프로젝트 루트 절대 경로"),
      sourceDirectory: z.string().describe("프로젝트 안 로컬 업로드 폴더의 절대 경로"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ projectRoot, sourceDirectory }) => {
    try {
      const snapshot = await snapshotFiles(
        withinProject(projectRoot, sourceDirectory),
      );
      return textResult({
        읽기_전용_미리보기: true,
        sourceSha256: snapshot.sourceSha256,
        objects: snapshot.objects.map(({ key, size, sha256: objectSha }) => ({
          key,
          size,
          sha256: objectSha,
        })),
        totalBytes: snapshot.objects.reduce((sum, object) => sum + object.size, 0),
        다음_단계:
          "Storage 코드 변경, 백업 위치와 검증 방법을 설명하고 사용자 승인을 받은 뒤 migrate_local_files를 호출한다",
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "migrate_local_files",
  {
    title: "승인된 로컬 파일 이전",
    description:
      "명시적 사용자 승인 뒤 로컬 파일 tar.gz 백업을 만들고 이미 생성된 Apps Storage binding으로 파일을 이전한다. Storage binding이 생긴 배포에만 쓴다. 파일 1,000개, 전체 512MB까지이고 기존 key는 덮어쓰지 않는다.",
    inputSchema: {
      projectRoot: z.string().describe("백업을 보관할 프로젝트 루트 절대 경로"),
      sourceDirectory: z.string().describe("프로젝트 안 로컬 업로드 폴더의 절대 경로"),
      deployment: z.string().describe("Storage binding이 연결된 배포 이름 또는 id"),
      approved: z.literal(true).describe("사용자가 파일 이전을 명시적으로 승인했을 때만 true"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ projectRoot, sourceDirectory, deployment, approved, workspace }) => {
    try {
      const prepared = await backupAndSnapshotFiles(projectRoot, sourceDirectory);
      const result = await callApi(
        `/v1/deployments/${encodeURIComponent(deployment)}/persistence/files-import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved, ...prepared.snapshot }),
        },
        workspace,
      );
      if (!result.ok) {
        return errorResult(
          `파일 이전에 실패했다. 원본과 백업은 유지했다: ${prepared.backupPath}\n${
            typeof result.body === "string"
              ? result.body
              : JSON.stringify(result.body, null, 2)
          }`,
        );
      }
      return textResult({
        이전됨: true,
        backupPath: prepared.backupPath,
        sourceSha256: prepared.snapshot.sourceSha256,
        ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "deployment_status",
  {
    title: "배포 상태 조회",
    description:
      "배포의 접속 URL, 현재 서비스 중인 revision과 가장 최근 배포 작업의 queued, building, healthcheck, running 또는 failed 상태를 조회한다. 이름이나 배포 id 로 찾는다. 실패는 결과의 failureSummary를 먼저 그대로 전한다. latestRevision.error.explanationStatus가 pending이면 10초쯤 뒤 한 번 더 조회하고, unavailable이면 오류 원문을 한국어로 풀어 덧붙인다. 이전 버전 실행 여부는 이 문장을 따른다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, workspace }) => {
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}`,
      {},
      workspace,
    );
    if (!result.ok) return failure("상태를 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "stop_deployment",
  {
    title: "배포 중지",
    description:
      "실행 중인 배포를 중지한다. 배포 기록과 영속 자원은 유지되며 같은 이름으로 다시 배포할 수 있다.",
    inputSchema: {
      deployment: z.string().describe("중지할 배포 이름 또는 배포 id"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, workspace }) => {
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}/stop`,
      { method: "POST" },
      workspace,
    );
    if (!result.ok) return failure("배포를 중지하지 못했다", result);
    return textResult({
      중지됨: true,
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
  },
);

server.registerTool(
  "move_deployment",
  {
    title: "앱 공간 이동",
    description: "사용자가 요청한 앱을 본인 개인 공간과 소속 조 사이에서 옮긴다. 앱 URL, 소스와 데이터를 유지하며 재배포하지 않는다. 대상 조에 앱이 이미 있으면 이동하지 않고 안내한다. apps_whoami로 실제 공간 UUID를 확인한다.",
    inputSchema: {
      deployment: z.string().min(1).describe("이동할 앱 이름 또는 ID"),
      workspace: z.string().min(1).describe("현재 앱이 있는 공간의 UUID 또는 slug"),
      targetWorkspace: z.string().min(1).describe("이동할 본인 개인 공간 또는 소속 조의 정확한 UUID"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ deployment, workspace, targetWorkspace }) => {
    const result = await callApi(`/v1/deployments/${encodeURIComponent(deployment)}/workspace`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: targetWorkspace }),
    }, workspace);
    if (!result.ok) return failure("앱을 이동하지 못했다. 대상 조에 앱이 이미 있으면 기존 앱을 삭제하거나 덮어쓰지 말고 안내한다", result);
    return textResult({ moved: true, deployment: result.body,
      instructions: "앱 이름, 이동한 공간과 유지된 URL을 안내한다. 해당 앱의 로컬 배포 기록이 있으면 정확히 일치하는 앱의 workspace만 새 UUID로 갱신하고 소스 기준 commit은 유지한다. 이동을 재배포로 대체하지 않는다." });
  },
);

server.registerTool(
  "delete_deployment",
  {
    title: "배포 삭제 확인 및 실행",
    description: "첫 호출은 삭제하지 않고 정확한 앱과 공간, 데이터 삭제 범위와 일회용 확인값을 반환한다. 이를 사용자에게 보여준 뒤 반드시 다음 응답에서 별도 확인을 받아야 한다. 최초 삭제 요청만으로 confirmedByUser를 설정하지 않는다.",
    inputSchema: {
      deployment: z.string().min(1).describe("삭제할 배포 이름 또는 ID"),
      workspace: WorkspaceInputSchema,
      confirmationToken: z.string().optional().describe("직전 미리보기에서 발급한 일회용 확인값. 처음 호출할 때는 생략한다"),
      confirmedByUser: z.boolean().optional().describe("삭제 대상을 보여준 뒤 사용자의 별도 후속 확인이 있을 때만 true"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ deployment, workspace, confirmationToken, confirmedByUser }) => {
    const identity = await callApi("/v1/me", {}, workspace);
    if (!identity.ok) return failure("삭제할 계정을 확인하지 못했다", identity);
    const actor = z.object({ user: z.object({ id: z.string() }) }).safeParse(identity.body);
    if (!actor.success) return errorResult("삭제할 계정을 확인하지 못했습니다. 삭제하지 않았습니다.");
    const current = await callApi(`/v1/deployments/${encodeURIComponent(deployment)}`, {}, workspace);
    if (!current.ok) return failure("삭제할 앱을 확인하지 못했다", current);
    try {
      if (!confirmationToken || confirmedByUser !== true) return textResult(await deletionConfirmations.request(current.body, actor.data.user.id, apiBase()));
      const app = await deletionConfirmations.consume(confirmationToken, current.body, actor.data.user.id, apiBase());
      const result = await callApi(`/v1/deployments/${encodeURIComponent(app.id)}?resourcePolicy=delete`, { method: "DELETE" }, app.workspaceId);
      if (!result.ok) return failure("삭제 결과를 확인하지 못했다. 자동으로 다시 삭제하지 말고 앱 상태를 먼저 확인한다", result);
      return textResult({ 삭제됨: true, 자원정책: "delete", ...(typeof result.body === "string" ? { 응답: result.body } : result.body) });
    } catch (error) { return errorResult(error instanceof Error ? error.message : "삭제 확인에 실패했습니다. 삭제하지 않았습니다."); }
  },
);

server.registerTool(
  "deployment_config",
  {
    title: "배포 설정 조회",
    description:
      "배포에 저장된 일반 환경변수 값과 비밀값 키 이름을 조회한다. 비밀값 원문은 반환하지 않는다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, workspace }) => {
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}/config`,
      {},
      workspace,
    );
    if (!result.ok) return failure("설정을 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "set_deployment_config",
  {
    title: "배포 설정 변경",
    description:
      "일반 환경변수와 비밀값을 추가, 교체, 삭제한다. null 값은 해당 키를 삭제한다. 변경 내용은 다음 배포부터 적용되며 비밀값 원문은 응답하지 않는다. 한 키를 env와 secrets에 함께 넣지 않는다. PORT, DATABASE_URL, APPS_로 시작하는 플랫폼 관리 값은 바꾸지 않는다. 비밀값을 바꾼 뒤 재배포하면 새 revision이 정상 실행되는지 확인한다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
      env: z
        .record(z.string(), z.union([z.string(), z.null()]))
        .optional()
        .describe("일반 환경변수 변경. 문자열은 저장, null 은 삭제"),
      secrets: z
        .record(z.string(), z.union([z.string().min(1), z.null()]))
        .optional()
        .describe(
          "비밀값 변경. 문자열은 암호화 저장, null 은 삭제. 조회 결과에는 키 이름만 나온다",
        ),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, env, secrets, workspace }) => {
    if (env === undefined && secrets === undefined) {
      return errorResult("env 또는 secrets 중 하나가 필요하다");
    }
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}/config`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(env === undefined ? {} : { env }),
          ...(secrets === undefined ? {} : { secrets }),
        }),
      },
      workspace,
    );
    if (!result.ok) return failure("설정을 변경하지 못했다", result);
    return textResult({
      변경됨: true,
      적용시점: "다음 배포",
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
  },
);

server.registerTool(
  "deployment_logs",
  {
    title: "배포 로그 조회",
    description:
      "배포의 빌드 로그나 실행 로그를 조회한다. 배포가 실패했을 때 원인을 확인하는 수단이다. 사용자에게는 failureSummary를 먼저 전하고 로그 원문을 길게 옮기지 않는다.",
    inputSchema: {
      deployment: z.string().describe("배포 이름 또는 배포 id"),
      type: z
        .enum(["build", "runtime"])
        .default("build")
        .describe("build 는 이미지 빌드 로그, runtime 은 실행 중인 앱의 로그"),
      revisionId: z
        .string()
        .optional()
        .describe("특정 revision 의 로그를 볼 때 지정한다. 생략하면 최신 revision"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ deployment, type, revisionId, workspace }) => {
    let targetRevision = revisionId;

    if (targetRevision === undefined) {
      const revisions = await callApi(
        `/v1/deployments/${encodeURIComponent(deployment)}/revisions`,
        {},
        workspace,
      );
      if (!revisions.ok) return failure("revision 목록을 조회하지 못했다", revisions);
      if (typeof revisions.body === "string") {
        return errorResult("revision 목록 응답을 해석하지 못했다");
      }
      const list = revisions.body["revisions"];
      if (!Array.isArray(list) || list.length === 0) {
        return errorResult("revision 이 없다");
      }
      targetRevision = (list[0] as { id: string }).id;
    }

    const result = await callApi(
      `/v1/revisions/${encodeURIComponent(targetRevision)}/logs?type=${type}`,
      {},
      workspace,
    );
    if (!result.ok) return failure("로그를 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "checkout_app_source",
  {
    title: "최신 앱 소스 가져오기",
    description: "GitLab 기본 브랜치의 소스를 새 폴더로 가져온다. 기존 작업 폴더를 덮어쓰지 않는다. 충돌 시 기준 소스와 자신의 변경을 비교해 최신 폴더에 통합하고 검증한 뒤 재배포한다. 요구사항이 양립하지 않을 때만 사용자에게 판단을 요청한다.",
    inputSchema: { deployment: z.string(), directory: z.string().describe("새로 만들 로컬 폴더의 절대 경로"), commit: z.string().regex(/^[a-f0-9]{40}$/).optional().describe("생략하면 최신 소스. 충돌 비교를 위해 작업 시작 당시 기준 커밋을 지정할 수 있다"), workspace: WorkspaceInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ deployment, directory, commit: reference, workspace }) => {
    if (!path.isAbsolute(directory)) return errorResult("새 폴더의 절대 경로를 지정한다");
    const result = await callApi(`/v1/deployments/${encodeURIComponent(deployment)}/source${reference ? `?commit=${reference}` : ""}`, {}, workspace);
    if (!result.ok) return failure("최신 소스를 가져오지 못했다", result);
    try {
      const canonicalName = typeof result.body === "object" && result.body !== null && typeof (result.body as { deployment?: unknown }).deployment === "string" ? (result.body as { deployment: string }).deployment : deployment;
      const commit = await checkoutSnapshot(directory, result.body, apiBase(), canonicalName, workspace);
      return textResult({ directory, sourceBaseCommit: commit, 안내: "이 폴더에 자신의 변경을 통합하고 검증한 뒤 이 폴더 경로로 deploy_project를 호출한다. 기준 커밋은 이 폴더의 .apps-source.json에서 자동으로 보낸다. .apps-source.json을 고치지 않는다" });
    } catch (error) { return errorResult(error instanceof Error ? error.message : "소스를 저장하지 못했다"); }
  },
);

server.registerTool(
  "list_educations",
  {
    title: "내 교육",
    description: "배포할 수 있는 교육 목록(id, name)과 교육 선택 안내(guide)를 조회한다. 새 개인 앱을 만들 때 교육이 둘 이상이면 이 목록을 사용자에게 보여 주고 고른 교육의 id를 deploy_project의 education에 넣는다. 하나뿐이면 참가자는 고르지 않고 운영진은 이 목록에서 고른다. 기존 앱 재배포와 조 앱에는 쓰지 않는다. 배포 공간(개인, 조)은 apps_whoami의 workspaces로 정한다.",
    inputSchema: {},
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },
  async()=>{
    const result=await callApi("/v1/educations",{});
    return result.ok ? textResult(result.body) : failure("교육을 조회하지 못했다",result);
  },
);

server.registerTool(
  "list_deployment_organizations",
  {
    title: "배포 가능한 교육 소속 (호환)",
    description: "이전 클라이언트 호환 조회. 새 호출은 공간을 apps_whoami의 workspaces로, 교육을 list_educations로 정한다.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    const result = await callApi("/v1/deployment-organizations", {});
    if (!result.ok) return failure("조직을 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "list_deployments",
  {
    title: "배포 목록",
    description: "내가 이 Apps 에 올린 배포 목록과 각각의 상태를 조회한다.",
    inputSchema: { workspace: WorkspaceInputSchema },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ workspace }) => {
    const result = await callApi("/v1/deployments", {}, workspace);
    if (!result.ok) return failure("목록을 조회하지 못했다", result);
    return textResult(result.body);
  },
);

server.registerTool(
  "apps_plugin_status",
  {
    title: "Apps 플러그인 상태",
    description:
      "현재 대화에 실제로 로드된 Apps 플러그인 버전과 API 주소를 확인한다. 설치 목록이 아니라 실행 중인 MCP 프로세스의 버전을 반환한다. authenticationMode가 automatic이면 Claude 데스크톱의 에이블캠퍼스 로그인으로 자동 연결되므로 로그인을 시작하지 않는다. device-login이면 start_apps_login을 쓴다. 인증 전에도 부를 수 있으며 작업을 시작할 때 한 번 부른다.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => textResult({
    plugin: "aiblecampus-apps",
    version: PLUGIN_VERSION,
    apiUrl: apiBase(),
    // automatic: hub 마켓플레이스가 넣은 자동 연결 Credential을 쓴다. device-login: 기기 로그인(start_apps_login)을 쓴다
    authenticationMode: usableHubCredential(apiBase()) === null ? "device-login" : "automatic",
    // hub: Claude 데스크톱이 hub 마켓플레이스에서 받은 판. public: 공개 마켓플레이스(Claude Code, Claude 구독 로그인 등). 설치와 갱신 절차가 다르다(0.40.1)
    distribution: pluginDistribution(),
  }),
);

server.registerTool(
  "apps_whoami",
  {
    title: "Apps 연결 확인",
    description:
      "Apps 주소와 토큰 설정이 올바른지 확인한다. 배포가 인증 문제로 실패할 때 먼저 부른다. 개인 공간과 소속 조의 UUID와 배포 권한을 확인한다. 조 이름은 결과의 name을 그대로 쓰고 교육명을 붙이지 않는다.",
    inputSchema: { workspace: WorkspaceInputSchema },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ workspace }) => {
    const result = await callApi("/v1/me", {}, workspace);
    if (!result.ok) return failure("연결을 확인하지 못했다", result);
    return textResult({
      주소: apiBase(),
      ...(result.body as JsonRecord),
      client: { plugin: "aiblecampus-apps", version: PLUGIN_VERSION },
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
