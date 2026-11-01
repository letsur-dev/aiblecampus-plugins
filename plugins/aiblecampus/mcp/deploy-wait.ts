/**
 * 비동기 배포(0.51.0)의 기다리기. 서버가 요청 헤더 `Prefer: respond-async`에 202와 상태 조회 경로를 주면 한 번의 도구 호출 안에서
 * 짧은 상태 조회를 2~3초 간격으로 되풀이해 running이나 failed를 기다린다.
 *
 * - 한 번의 호출이 기다리는 최대 시간은 APPS_DEPLOY_WAIT_SECONDS(기본 40초)다. Claude 데스크톱과 Cowork가 도구 호출을 약 60초에 끊는다는
 *   보고가 있어 그 안에 끝낸다. 넘으면 오류가 아니라 '진행 중' 결과로 끝내고 deployment_status(waitSeconds)로 이어서 기다리게 한다
 * - 상태 조회 한 번은 15초 안에 끝나야 하고(요청이 짧아 undici의 300초 한도와 무관하다), 취소 신호가 오면 바로 멈춘다
 * - 진행 알림(notifications/progress)은 호출이 progressToken을 가졌을 때만 보낸다(Claude Code CLI가 작업 항목에 보여 준다)
 */
import { z } from "zod";
import type { ApiResult } from "./failure.ts";
import { appsEnv } from "./config.ts";

/** 한 번의 도구 호출이 기다리는 기본 시간(초). 60초에서 끊기는 클라이언트를 피한다 */
export const DEPLOY_WAIT_DEFAULT_SECONDS = 40;
/** 설정으로 늘릴 수 있는 한 번의 대기 상한(초). Claude Code CLI처럼 한도가 긴 클라이언트용이다 */
export const DEPLOY_WAIT_MAX_SECONDS = 900;
/** 상태 조회 한 번의 제한 시간 */
const STATUS_REQUEST_TIMEOUT_MS = 15_000;
const POLL_DEFAULT_MS = 2_500;

/** 한 번의 도구 호출이 기다리는 시간(초). APPS_DEPLOY_WAIT_SECONDS가 올바른 정수면 그 값(1 이상, 상한 900)이고 아니면 40이다 */
export function deployWaitSeconds(): number {
  const raw = appsEnv("DEPLOY_WAIT_SECONDS");
  if (raw === undefined || raw === "") return DEPLOY_WAIT_DEFAULT_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEPLOY_WAIT_DEFAULT_SECONDS;
  return Math.min(value, DEPLOY_WAIT_MAX_SECONDS);
}

/** 상태 조회 간격(밀리초). 서버가 권한 간격을 주면 그 값을 2~3초로 맞춘다. APPS_DEPLOY_POLL_MS는 시험용으로 이 범위를 풀어 준다 */
export function deployPollMs(serverHint?: number): number {
  const raw = appsEnv("DEPLOY_POLL_MS");
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 10) return value;
  }
  const hint = serverHint !== undefined && Number.isFinite(serverHint) ? serverHint : POLL_DEFAULT_MS;
  return Math.min(Math.max(hint, 2_000), 3_000);
}

/** 202 접수 응답. 쓰는 필드만 읽는다 */
export const AcceptedDeployment = z.looseObject({
  accepted: z.literal(true),
  deploymentId: z.string().min(1),
  revisionId: z.string().min(1),
  statusPath: z.string().startsWith("/v1/deployments/").optional(),
  revisionNumber: z.number().int().optional(),
  status: z.string().optional(),
  pollAfterMs: z.number().optional(),
});
export type AcceptedDeployment = z.infer<typeof AcceptedDeployment>;

/** 회차 상태 조회 응답(GET /v1/deployments/:id/revisions/:revisionId). 쓰는 필드만 읽는다 */
export const RevisionState = z.looseObject({
  id: z.string().optional(),
  number: z.number().int().optional(),
  status: z.string(),
  phase: z.string().optional(),
  error: z
    .looseObject({
      stage: z.string(),
      message: z.string(),
      code: z.string().optional(),
      status: z.number().int().optional(),
      details: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type RevisionState = z.infer<typeof RevisionState>;

/** 단계 이름. 진행 안내와 '진행 중' 결과에 쓴다 */
export function phaseLabel(state: Pick<RevisionState, "status" | "phase">): string {
  switch (state.phase ?? state.status) {
    case "queued":
      return "배포 대기";
    case "build":
      return "빌드 중";
    case "start":
      return "앱 기동 중";
    case "health":
      return "동작 확인 중";
    case "done":
    case "running":
      return "실행 중, 결과 정리 중";
    default:
      return state.status === "building" ? "빌드와 기동 중" : state.status;
  }
}

export type WaitOutcome =
  | { kind: "running"; state: RevisionState; result: Record<string, unknown> }
  | { kind: "failed"; state: RevisionState; failure: { stage: string; message: string; status: number; details: unknown } }
  | { kind: "pending"; state: RevisionState | null; elapsedMs: number }
  | { kind: "error"; result: ApiResult };

export type WaitOptions = {
  /** 상태 한 번 조회. signal은 15초 제한과 취소를 합친 것이다 */
  fetchState: (signal: AbortSignal) => Promise<ApiResult>;
  /** 이 시각(Date.now 기준 밀리초)까지만 기다린다 */
  deadline: number;
  pollMs: number;
  /** 도구 호출 취소 신호 */
  signal?: AbortSignal | undefined;
  /** 진행 안내. 단계가 바뀌었거나 조회할 때마다 부른다 */
  onProgress?: ((message: string, elapsedMs: number) => Promise<void> | void) | undefined;
  startedAt?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted === true) {
    resolve();
    return promise;
  }
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  function done(): void {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  }
  return promise;
}

/**
 * 회차가 running(결과 포함)이나 failed가 될 때까지, 또는 기한이 될 때까지 상태를 조회한다.
 * 조회 자체가 실패하면(인증, 네트워크, 404) 그 응답을 그대로 돌려주고, 일시적인 5xx와 연결 실패는 기한 안에서 다시 시도한다
 */
export async function waitForRevision(options: WaitOptions): Promise<WaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = options.startedAt ?? now();
  let last: RevisionState | null = null;
  const cancelled = (): boolean => options.signal?.aborted === true;
  for (;;) {
    if (cancelled()) return { kind: "pending", state: last, elapsedMs: now() - startedAt };
    const request = AbortSignal.any([AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS), ...(options.signal === undefined ? [] : [options.signal])]);
    const response = await options.fetchState(request);
    if (cancelled()) return { kind: "pending", state: last, elapsedMs: now() - startedAt };
    const transient = !response.ok && (response.status === 0 || response.status >= 500);
    if (!response.ok && !transient) return { kind: "error", result: response };
    const parsed = response.ok ? RevisionState.safeParse(response.body) : null;
    if (response.ok && !parsed?.success) return { kind: "error", result: { ok: false, status: response.status, body: "회차 상태 응답 형식이 올바르지 않다" } };
    const state = parsed?.success ? parsed.data : null;
    if (state !== null) {
      last = state;
      if (state.status === "running" && state.result !== null && state.result !== undefined) return { kind: "running", state, result: state.result };
      if (state.status === "failed") {
        const error = state.error;
        return {
          kind: "failed",
          state,
          failure: { stage: error?.stage ?? "build", message: error?.message ?? "배포에 실패했다", status: error?.status ?? 422, details: error?.details ?? null },
        };
      }
      if (state.status === "stopped") {
        return { kind: "failed", state, failure: { stage: "run", message: "배포한 버전이 이미 중지됐다", status: 409, details: null } };
      }
      const label = phaseLabel(state);
      const elapsedMs = now() - startedAt;
      if (options.onProgress !== undefined) await options.onProgress(`${label} (${Math.round(elapsedMs / 1000)}초 경과)`, elapsedMs);
    }
    if (now() + options.pollMs >= options.deadline) return { kind: "pending", state: last, elapsedMs: now() - startedAt };
    await sleep(options.pollMs, options.signal);
  }
}
