import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { loadSelectedLocalEnv } from "./local-env.ts";

export class AiSetupError extends Error {}

export const AI_ENV_FILE = ".env.apps-ai";
export const AI_ENV_KEYS = ["LETSUR_BASE_URL", "LETSUR_MODEL"];
export const AI_SECRET_KEYS = ["LETSUR_API_KEY"];
const configurationSchema = z.object({
  environment: z.object({ id: z.string().uuid(), name: z.string().min(1).max(200) }),
  baseUrl: z.literal("https://gw.letsur.ai/v1"),
  apiKey: z.string().regex(/^sk-[A-Za-z0-9_-]+$/),
  models: z.array(z.string().min(1).max(200)),
});
const marker = "# Managed by AibleCampus Apps AI. Do not commit this file.";

async function assertNotTracked(root: string) {
  let current = root;
  for (;;) {
    if (await lstat(path.join(current, ".git")).catch(() => null)) {
      try {
        await promisify(execFile)("git", ["-C", root, "ls-files", "--error-unmatch", "--", AI_ENV_FILE], { timeout: 5000 });
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) return;
        throw new AiSetupError("Git 추적 상태를 확인하지 못했습니다.");
      }
      throw new AiSetupError(".env.apps-ai가 Git에 추적되고 있습니다. 먼저 추적에서 제외하십시오.");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function plainFile(file: string): Promise<boolean> {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AiSetupError("설정 경로는 연결 파일이 아닌 일반 파일이어야 합니다.");
  return true;
}

export async function configureAiGateway(projectPath: string, model: string, input: unknown) {
  const parsed = configurationSchema.safeParse(input);
  if (!parsed.success) throw new AiSetupError("AI 설정 응답 형식을 확인하지 못했습니다.");
  const config = parsed.data;
  if (!config.models.includes(model)) throw new AiSetupError("현재 Gateway 목록에서 모델을 선택하십시오.");
  const root = await realpath(projectPath);
  if (!(await lstat(root)).isDirectory()) throw new AiSetupError("프로젝트 폴더를 지정하십시오.");
  await assertNotTracked(root);
  const lockPath = path.join(root, ".apps-ai-setup.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new AiSetupError("AI 설정이 진행 중이거나 잠금 파일이 있습니다."); });
  const target = path.join(root, AI_ENV_FILE);
  const temporary = path.join(root, `.env.apps-ai-${randomUUID()}`);
  try {
    if (await plainFile(target)) {
      const existing = await readFile(target, "utf8");
      if (!existing.startsWith(marker + "\n")) throw new AiSetupError("기존 .env.apps-ai는 플러그인이 만든 파일이 아니므로 덮어쓰지 않습니다.");
      const assignments = existing.split("\n").filter((line) => line && !line.startsWith("#"));
      if (assignments.length !== 3 || assignments.some((line) => !/^(LETSUR_BASE_URL|LETSUR_MODEL|LETSUR_API_KEY)=/.test(line)))
        throw new AiSetupError(".env.apps-ai에 다른 설정이 있어 자동으로 덮어쓰지 않습니다.");
    }
    const ignore = path.join(root, ".gitignore");
    const existingIgnore = await plainFile(ignore) ? await readFile(ignore, "utf8") : "";
    // Append at the end so earlier negation patterns cannot expose the generated files.
    const ignoreSuffix = "\n# AibleCampus private AI configuration\n.env.apps-ai\n.env.apps-ai-*\n.apps-ai-setup.lock\n";
    if (!existingIgnore.endsWith(ignoreSuffix)) {
      const handle = await open(ignore, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
      try { await handle.writeFile(ignoreSuffix); } finally { await handle.close(); }
    }
    const body = `${marker}\nLETSUR_BASE_URL=${JSON.stringify(config.baseUrl)}\nLETSUR_MODEL=${JSON.stringify(model)}\nLETSUR_API_KEY=${JSON.stringify(config.apiKey)}\n`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(body); } finally { await handle.close(); }
    await rename(temporary, target);
    return { configured: true, environment: config.environment, baseUrl: config.baseUrl, model,
      localEnv: { file: AI_ENV_FILE, envKeys: AI_ENV_KEYS, secretKeys: AI_SECRET_KEYS },
      nextAction: "서버에서 .env.apps-ai를 읽도록 구현하고 로컬 요청과 응답을 검증하십시오. 배포는 명시적으로 요청받았을 때만 수행합니다." };
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

/** One small, non-streaming call. Never return credentials, headers or arbitrary upstream errors. */
export async function verifyAiGateway(projectPath: string, fetcher: typeof fetch = fetch) {
  const selected = await loadSelectedLocalEnv(projectPath, { file: AI_ENV_FILE, envKeys: AI_ENV_KEYS, secretKeys: AI_SECRET_KEYS });
  if (selected.env["LETSUR_BASE_URL"] !== "https://gw.letsur.ai/v1") throw new AiSetupError("공식 Gateway 주소를 확인하십시오.");
  let response: Response;
  try {
    response = await fetcher(`${selected.env["LETSUR_BASE_URL"]}/chat/completions`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${selected.secrets["LETSUR_API_KEY"]}` },
      body: JSON.stringify({ model: selected.env["LETSUR_MODEL"], messages: [{ role: "user", content: "연결 확인입니다. '연결 성공'이라고 짧게 답하세요." }], stream: false, max_tokens: 64 }),
    });
  } catch { throw new AiSetupError("Gateway 연결이 끝나지 않았습니다. 자동으로 재시도하지 않았습니다."); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ type: z.string().regex(/^[a-z_]{1,80}$/).optional() }).safeParse(body);
    return { verified: false, httpStatus: response.status, errorType: error.success ? error.data.type ?? "gateway_error" : "gateway_error",
      nextAction: "공식 오류 가이드에 따라 인증, 한도, 모델 지원 여부를 확인하십시오. 자동 재시도는 수행하지 않았습니다." };
  }
  const result = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string() })).min(1) }).safeParse(body);
  const first = result.success ? result.data.choices[0] : undefined;
  return { verified: Boolean(first?.message.content.trim()) && first?.finish_reason === "stop", httpStatus: response.status,
    model: selected.env["LETSUR_MODEL"], responseCharacters: first?.message.content.length ?? 0, finishReason: first?.finish_reason ?? "invalid_response",
    scope: "Gateway 연결 검증입니다. 산출물 서버와 화면의 통합 검증은 별도로 수행하십시오." };
}
