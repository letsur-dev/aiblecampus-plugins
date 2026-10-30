import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { appsEnv } from "./config.ts";
import { withFileLock } from "./file-lock.ts";

const Deployment = z.object({
  id: z.string().min(1), name: z.string().min(1), url: z.string(), workspaceId: z.string().min(1),
  workspace: z.object({ id: z.string(), name: z.string(), type: z.enum(["personal", "team"]), canDeleteApps: z.boolean() }),
  updatedAt: z.string(), currentRevision: z.object({ id: z.string() }).nullable(), latestRevision: z.object({ id: z.string() }).nullable(),
});
const Pending = z.object({ fingerprint: z.string(), expiresAt: z.number() });
const State = z.object({ version: z.literal(1), pending: z.record(z.string(), Pending) });
type State = z.infer<typeof State>;

/** 사람이 삭제 대상을 읽고 답하는 데 넉넉한 시간(2026-10-18 시뮬: 클로드가 묻고 답을 받는 사이에 만료됐다) */
export const CONFIRMATION_TTL_MS = 10 * 60_000;
const CONFIRMATION_EXPIRED_MESSAGE =
  "삭제 확인 시간(10분)이 지나 삭제하지 않았습니다. 사용자에게 \"확인 시간이 지나 삭제하지 않았어요. 삭제하려면 다시 요청해 주세요\"라고 알리세요. 다시 요청하면 처음부터(확인값 없이) 미리보기를 받아 다시 확인합니다.";

function defaultFile(): string {
  const configured = appsEnv("DELETE_CONFIRMATION_FILE");
  if (configured) return path.resolve(configured);
  const configRoot = process.env["XDG_CONFIG_HOME"]?.trim() || path.join(homedir(), ".config");
  return path.join(configRoot, "aiblecampus-apps", "delete-confirmations.json");
}

/**
 * 삭제 확인값. 일회용이고 확인한 앱, 공간, 배포 상태, 계정, API에 묶인다.
 * 권한 0600 파일에 둔다. 클로드가 대화 차례마다 MCP 프로세스를 새로 띄워도 사람이 답하는 사이에 확인값이 사라지지 않는다(2026-10-18 시뮬 I-20, 10-20초 만에 만료)
 */
export class DeletionConfirmations {
  private readonly now: () => number;
  private readonly file: string;
  constructor(options: { now?: () => number; file?: string } = {}) {
    this.now = options.now ?? Date.now;
    this.file = options.file ?? defaultFile();
  }
  private prepare(raw: unknown, actor: string, api: string) {
    const app = Deployment.parse(raw);
    if (!app.workspace.canDeleteApps || app.workspace.id !== app.workspaceId) throw new Error("이 앱을 삭제할 권한이 없습니다.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ api, actor, app })).digest("hex");
    return { app, fingerprint };
  }
  /** 파일을 잠그고 읽어 지난 확인값을 지운 뒤 change를 적용해 쓴다. 형식이 깨진 파일은 비운다(확인값을 잃을 뿐 삭제가 일어나지 않는다) */
  private update<T>(change: (state: State) => T): Promise<T> {
    return withFileLock(this.file, async () => {
      let state: State = { version: 1, pending: {} };
      const text = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (text !== null) {
        try {
          const parsed = State.safeParse(JSON.parse(text));
          if (parsed.success) state = parsed.data;
        } catch {
          // 깨진 파일은 빈 상태로 다시 쓴다
        }
      }
      for (const [token, value] of Object.entries(state.pending)) if (value.expiresAt <= this.now()) delete state.pending[token];
      const result = change(state);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
      return result;
    });
  }
  async request(raw: unknown, actor: string, api: string) {
    const { app, fingerprint } = this.prepare(raw, actor, api);
    const confirmationToken = randomUUID();
    const expiresAt = this.now() + CONFIRMATION_TTL_MS;
    await this.update((state) => {
      const tokens = Object.keys(state.pending);
      if (tokens.length >= 100) delete state.pending[tokens[0]!];
      state.pending[confirmationToken] = { fingerprint, expiresAt };
    });
    return {
      confirmationRequired: true, confirmationToken, expiresAt: new Date(expiresAt).toISOString(),
      deployment: { id: app.id, name: app.name, url: app.url, workspace: app.workspace },
      consequences: "앱과 전용 데이터베이스, 저장 파일이 영구 삭제되며 소스 저장소도 삭제 대상으로 표시됩니다.",
      instructions: "아직 삭제하지 않았습니다. 앱 이름, URL, 개인 또는 조 공간과 삭제 범위를 사용자에게 보여주고 정말 삭제할지 다시 물으세요. 확인값은 10분 동안 유효합니다. 최초 삭제 요청을 재확인으로 간주하지 마세요. 이번 응답에서 실행을 멈추고 사용자의 다음 명시적 확인을 기다리세요. 확인 후 같은 앱과 공간, confirmationToken, confirmedByUser:true로 다시 호출하세요. 거절하거나 응답이 없으면 호출하지 마세요.",
    };
  }
  async consume(token: string, raw: unknown, actor: string, api: string) {
    const pending = await this.update((state) => {
      const value = state.pending[token];
      delete state.pending[token];
      return value;
    });
    if (pending === undefined || pending.expiresAt <= this.now()) throw new Error(CONFIRMATION_EXPIRED_MESSAGE);
    const { app, fingerprint } = this.prepare(raw, actor, api);
    if (pending.fingerprint !== fingerprint) throw new Error("확인한 뒤 앱, 소속, 배포 상태 또는 계정이 바뀌어 삭제하지 않았습니다. 사용자에게 \"앱이 그사이 바뀌어 삭제하지 않았어요. 삭제하려면 다시 요청해 주세요\"라고 알리세요.");
    return app;
  }
}
