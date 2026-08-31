import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packDirectory } from "./pack.ts";
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
} from "./persistence-migration.ts";

/**
 * PaaS 접속 주소. DNS 전에는 현재 nip.io 운영 주소를 기본값으로 쓰고 환경변수로
 * 다른 환경과 공식 도메인으로 전환한다.
 */
function apiBase(): string {
  return process.env["PAAS_API_URL"]?.trim() || "https://api.161.33.218.143.nip.io";
}

const TOKEN_MISSING =
  "PaaS Device Credential이 없다.\n" +
  "start_paas_login 으로 로그인을 시작하고 표시된 주소와 코드로 승인한 뒤 complete_paas_login 을 실행한다.\n" +
  "이전 service Credential을 쓰는 운영 환경은 PAAS_TOKEN을 계속 사용할 수 있다.";

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

const WorkspaceInputSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "대상 Workspace의 ID 또는 slug. 생략하면 개인 Workspace를 사용한다",
  );

async function callApi(
  urlPath: string,
  init: RequestInit = {},
  workspace?: string,
): Promise<ApiResult> {
  let response: Response;
  try {
    const url = `${apiBase()}${urlPath}`;
    const method = init.method ?? "GET";
    const serviceCredential = process.env["PAAS_TOKEN"]?.trim();
    const authentication = serviceCredential
      ? { authorization: `Bearer ${serviceCredential}` }
      : await deviceRequestHeaders(apiBase(), url, method);
    if (authentication === null) {
      return { ok: false, status: 0, body: TOKEN_MISSING };
    }
    const headers = new Headers(init.headers);
    if (workspace !== undefined) headers.set("x-paas-workspace", workspace);
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
        `PaaS 에 연결하지 못했다: ${apiBase()}\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        "PAAS_API_URL 이 올바른지, 플랫폼이 기동 중인지 확인한다.",
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

/** 실패 응답을 사람과 agent 가 함께 읽을 수 있는 형태로 만든다. */
function failure(prefix: string, result: ApiResult): ReturnType<typeof errorResult> {
  if (result.status === 0) return errorResult(String(result.body));
  if (result.status === 401) {
    return errorResult(
      `${prefix}: 인증에 실패했다 (401).\n기기 로그인을 다시 진행한다. PAAS_TOKEN을 쓰는 운영 환경은 해당 service Credential이 폐기됐는지 확인한다.`,
    );
  }
  return errorResult(
    `${prefix} (HTTP ${result.status})\n${
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2)
    }`,
  );
}

const server = new McpServer({
  name: "aiblecampus-paas",
  version: "0.13.0",
});

server.registerTool(
  "start_paas_login",
  {
    title: "PaaS 기기 로그인 시작",
    description: "Identity에서 기기별 로그인 코드와 승인 주소를 발급하고 원문 device code는 로컬 보호 파일에만 저장한다.",
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
      return textResult(await startDeviceLogin(apiBase()));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
);

server.registerTool(
  "complete_paas_login",
  {
    title: "PaaS 기기 로그인 완료",
    description: "사용자 승인 상태를 Identity 표준 polling 간격에 맞춰 확인하고 성공하면 이 기기의 Credential을 0600 로컬 파일에 저장한다.",
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
      "프로젝트를 빌드하거나 실행하지 않고 배포 가능 여부를 판정한다. runtime, 프레임워크, 실행 명령, PORT와 bind, 환경변수, PostgreSQL과 파일 Storage 요구, Dockerfile 위험을 구조화해 반환한다.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "검증할 프로젝트의 로컬 디렉토리 절대 경로이거나 public git 저장소의 https 주소다",
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
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ path: projectPath, ref, subdir, env, secretKeys, workspace }) => {
    if (looksLikeGitUrl(projectPath)) {
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
    if (env !== undefined) form.set("env", JSON.stringify(env));
    if (secretKeys !== undefined) {
      form.set("secretKeys", JSON.stringify(secretKeys));
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
      "프로젝트를 에이블캠퍼스 PaaS 에 배포한다. 로컬 디렉토리 경로를 주면 tar.gz 로 묶어 올리고, git 주소를 주면 서버가 직접 clone 한다. 빌드와 실행, 접속 URL 발급까지 수행한다.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "배포할 프로젝트의 위치. 로컬 디렉토리의 절대 경로(보통 현재 작업 디렉토리)이거나 public git 저장소의 https 주소다",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "배포 이름. 접속 URL 의 하위 도메인이 된다. 생략하면 디렉토리 이름에서 만든다",
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
        .describe("배포 컨테이너에 주입할 일반 환경변수"),
      secrets: z
        .record(z.string(), z.string().min(1))
        .optional()
        .describe(
          "배포 컨테이너에 안전하게 주입할 비밀값. 응답과 로그에는 값이 표시되지 않는다",
        ),
      resources: z
        .object({
          cpus: z.number().positive(),
          memoryMb: z.number().int().min(64),
        })
        .optional()
        .describe(
          "프로젝트에 적용할 CPU 수와 메모리 MB. 생략하면 플랫폼 기본값을 사용하며 운영 상한을 넘으면 배포가 거부된다",
        ),
      workspace: WorkspaceInputSchema,
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
    resources,
    workspace,
  }) => {
    // git 주소면 서버가 직접 clone 한다. 업로드가 없어 큰 저장소에서 훨씬 빠르다.
    if (looksLikeGitUrl(projectPath)) {
      const deploymentName = toDeploymentName(
        name ?? gitRepoNameOf(projectPath),
      );
      const result = await callApi("/v1/deployments/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: deploymentName,
          url: projectPath,
          ...(ref === undefined ? {} : { ref }),
          ...(subdir === undefined ? {} : { subdir }),
          env: env ?? {},
          ...(secrets === undefined ? {} : { secrets }),
          ...(resources === undefined ? {} : { resources }),
        }),
      }, workspace);
      if (!result.ok) return failure("배포에 실패했다", result);
      return textResult({
        배포됨: true,
        이름: deploymentName,
        소스: "git",
        ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
      });
    }

    if (!existsSync(projectPath)) {
      return errorResult(`경로가 없다: ${projectPath}`);
    }

    const deploymentName = toDeploymentName(name ?? path.basename(projectPath));

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
    form.set(
      "source",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      "source.tar.gz",
    );
    if (env !== undefined) form.set("env", JSON.stringify(env));
    if (secrets !== undefined) form.set("secrets", JSON.stringify(secrets));
    if (resources !== undefined) {
      form.set("resources", JSON.stringify(resources));
    }

    const result = await callApi("/v1/deployments", {
      method: "POST",
      body: form,
    }, workspace);

    // 실패 단계와 원인을 그대로 전달해야 agent 가 다음 행동을 판단할 수 있다.
    if (!result.ok) return failure("배포에 실패했다", result);

    return textResult({
      배포됨: true,
      이름: deploymentName,
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
      databasePath: z.string().describe("프로젝트 안 SQLite 파일의 절대 경로"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ databasePath }) => {
    try {
      const snapshot = await snapshotSqlite(databasePath);
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
      "명시적 사용자 승인 뒤 SQLite 일관 백업을 만들고 이미 생성된 PaaS PostgreSQL binding으로 데이터를 이전한다.",
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
      sourceDirectory: z.string().describe("프로젝트 안 로컬 업로드 폴더의 절대 경로"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sourceDirectory }) => {
    try {
      const snapshot = await snapshotFiles(sourceDirectory);
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
      "명시적 사용자 승인 뒤 로컬 파일 tar.gz 백업을 만들고 이미 생성된 PaaS Storage binding으로 파일을 이전한다.",
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
      "배포의 현재 상태, 접속 URL, 현재 revision 을 조회한다. 이름이나 배포 id 로 찾는다.",
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
  "delete_deployment",
  {
    title: "배포 삭제",
    description:
      "배포 기록과 실행 자원을 삭제한다. 영속 자원은 보존하거나 함께 삭제할지 명시해야 한다.",
    inputSchema: {
      deployment: z.string().describe("삭제할 배포 이름 또는 배포 id"),
      resourcePolicy: z
        .enum(["retain", "delete"])
        .describe("retain은 DB와 파일을 보존하고 delete는 함께 삭제한다"),
      workspace: WorkspaceInputSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ deployment, resourcePolicy, workspace }) => {
    const result = await callApi(
      `/v1/deployments/${encodeURIComponent(deployment)}?resourcePolicy=${resourcePolicy}`,
      { method: "DELETE" },
      workspace,
    );
    if (!result.ok) return failure("배포를 삭제하지 못했다", result);
    return textResult({
      삭제됨: true,
      자원정책: resourcePolicy,
      ...(typeof result.body === "string" ? { 응답: result.body } : result.body),
    });
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
      "일반 환경변수와 비밀값을 추가, 교체, 삭제한다. null 값은 해당 키를 삭제한다. 변경 내용은 다음 배포부터 적용되며 비밀값 원문은 응답하지 않는다.",
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
      "배포의 빌드 로그나 실행 로그를 조회한다. 배포가 실패했을 때 원인을 확인하는 수단이다.",
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
  "list_deployments",
  {
    title: "배포 목록",
    description: "내가 이 PaaS 에 올린 배포 목록과 각각의 상태를 조회한다.",
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
  "paas_whoami",
  {
    title: "PaaS 연결 확인",
    description:
      "PaaS 주소와 토큰 설정이 올바른지 확인한다. 배포가 인증 문제로 실패할 때 먼저 부른다.",
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
    return textResult({ 주소: apiBase(), ...(result.body as JsonRecord) });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
