import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";

const Deployment = z.object({
  id: z.string().min(1), name: z.string().min(1), url: z.string(), workspaceId: z.string().min(1),
  workspace: z.object({ id: z.string(), name: z.string(), type: z.enum(["personal", "team"]), canDeleteApps: z.boolean() }),
  updatedAt: z.string(), currentRevision: z.object({ id: z.string() }).nullable(), latestRevision: z.object({ id: z.string() }).nullable(),
});
type Pending = { fingerprint: string; expiresAt: number };
/** Process-local and single-use: a fresh process or changed target requires a fresh user confirmation. */
export class DeletionConfirmations {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  prepare(raw: unknown, actor: string, api: string) {
    const app = Deployment.parse(raw);
    if (!app.workspace.canDeleteApps || app.workspace.id !== app.workspaceId) throw new Error("이 앱을 삭제할 권한이 없습니다.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ api, actor, app })).digest("hex");
    return { app, fingerprint };
  }
  request(raw: unknown, actor: string, api: string) {
    const { app, fingerprint } = this.prepare(raw, actor, api);
    for (const [token, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(token);
    if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
    const confirmationToken = randomUUID();
    const expiresAt = this.now() + 5 * 60_000;
    this.pending.set(confirmationToken, { fingerprint, expiresAt });
    return {
      confirmationRequired: true, confirmationToken, expiresAt: new Date(expiresAt).toISOString(),
      deployment: { id: app.id, name: app.name, url: app.url, workspace: app.workspace },
      consequences: "앱과 전용 데이터베이스, 저장 파일이 영구 삭제되며 소스 저장소도 삭제 대상으로 표시됩니다.",
      instructions: "아직 삭제하지 않았습니다. 앱 이름, URL, 개인 또는 팀 공간과 삭제 범위를 사용자에게 보여주고 정말 삭제할지 다시 물으세요. 최초 삭제 요청을 재확인으로 간주하지 마세요. 이번 응답에서 실행을 멈추고 사용자의 다음 명시적 확인을 기다리세요. 확인 후 같은 앱과 공간, confirmationToken, confirmedByUser:true로 다시 호출하세요. 거절하거나 응답이 없으면 호출하지 마세요.",
    };
  }
  consume(token: string, raw: unknown, actor: string, api: string) {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.expiresAt <= this.now()) throw new Error("삭제 확인이 만료되었거나 이미 사용되었습니다. 대상을 다시 조회하고 사용자에게 다시 확인하세요.");
    const { app, fingerprint } = this.prepare(raw, actor, api);
    if (pending.fingerprint !== fingerprint) throw new Error("확인한 앱, 소속, 배포 상태 또는 계정이 변경되었습니다. 사용자에게 다시 확인하세요.");
    return app;
  }
}
