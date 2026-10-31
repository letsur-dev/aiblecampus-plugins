/**
 * 서버가 계속 진행 중인 배포(202 뒤 기다림 상한을 넘긴 것)의 로컬 기록(0.51.0). 나중에 deployment_status가 그 배포의 끝(running)을 보면
 * 프로젝트 폴더의 소스 기준(.apps-source.json)을 그 회차 커밋으로 맞춘다. 이것이 없으면 다음 배포가 낡은 기준으로 가 조 앱에서 소스 충돌이 날 수 있다.
 * 기록은 24시간 뒤 버리고 경로 값만 담는다(비밀값 없음). 여러 MCP 프로세스가 같은 파일을 쓰므로 파일 잠금 안에서 갱신한다
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { appsEnv } from "./config.ts";
import { withFileLock } from "./file-lock.ts";

export type PendingDeploy = {
  /** 소스 기준을 기록할 프로젝트 폴더 */
  projectPath: string;
  api: string;
  deployment: string;
  workspace: string | null;
  expiresAt: number;
};

type State = { version: 1; revisions: Record<string, PendingDeploy> };

const TTL_MS = 24 * 60 * 60 * 1000;

function defaultFile(): string {
  const configured = appsEnv("PENDING_DEPLOY_FILE");
  if (configured) return path.resolve(configured);
  const configRoot = process.env["XDG_CONFIG_HOME"]?.trim() || path.join(homedir(), ".config");
  return path.join(configRoot, "aiblecampus-apps", "pending-deploys.json");
}

async function read(file: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<State>;
    if (parsed.version === 1 && parsed.revisions !== null && typeof parsed.revisions === "object") return { version: 1, revisions: parsed.revisions };
  } catch {
    // 없거나 깨졌으면 비운다. 이 기록은 소스 기준을 맞추는 보조라 잃어도 배포는 영향이 없다
  }
  return { version: 1, revisions: {} };
}

async function write(file: string, state: State): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** 진행 중인 배포를 기록한다 */
export async function rememberPendingDeploy(revisionId: string, entry: Omit<PendingDeploy, "expiresAt">, options: { file?: string; now?: number } = {}): Promise<void> {
  const file = options.file ?? defaultFile();
  const now = options.now ?? Date.now();
  await withFileLock(file, async () => {
    const state = await read(file);
    for (const [id, item] of Object.entries(state.revisions)) if (item.expiresAt <= now) delete state.revisions[id];
    state.revisions[revisionId] = { ...entry, expiresAt: now + TTL_MS };
    await write(file, state);
  });
}

/** 끝난 배포의 기록을 꺼내 지운다. 없으면 null */
export async function takePendingDeploy(revisionId: string, options: { file?: string; now?: number } = {}): Promise<PendingDeploy | null> {
  const file = options.file ?? defaultFile();
  const now = options.now ?? Date.now();
  return withFileLock(file, async () => {
    const state = await read(file);
    const entry = state.revisions[revisionId];
    if (entry === undefined) return null;
    delete state.revisions[revisionId];
    await write(file, state);
    return entry.expiresAt > now ? entry : null;
  });
}
