/**
 * 이미지·영상 도구(generate_image, generate_video, video_status)의 실패 안내(0.48.0). 서버 거절 응답을 사용자가 이해하는 한국어 문장으로 바꾼다.
 *
 * - 서버 message를 그대로 전하고, 없으면 상태별 기본 문구를 쓴다
 * - 429 가운데 미디어 생성 한도 도달(서버 message "미디어 생성 한도 도달, 운영진 문의" 또는 옛 서버가 보내는 dailyLimit, remainingToday, resetsAt 칸이 있는 429)은 서버 message와 한도 칸을 모두 무시하고
 *   한도 도달 한 줄만 전한다. 참가자에게 한도 수치는 알리지 않는다. 그 밖의 429(서버의 요청 횟수 제한)는 서버 message를 그대로 전하고 잠시 뒤 다시 하라고 안내한다
 * - 키와 게이트웨이 원문은 서버가 넣지 않으므로 여기서도 그대로 옮기는 것은 message뿐이다
 */
import { z } from "zod";

export type MediaKind = "image" | "video";

/** noun은 이름, obj는 목적격(조사까지) */
const LABEL = { image: { noun: "이미지", obj: "이미지를" }, video: { noun: "영상", obj: "영상을" } } as const;

const MediaFailureBody = z.looseObject({
  message: z.string().trim().min(1).max(1000).optional(),
  dailyLimit: z.unknown().optional(),
  remainingToday: z.unknown().optional(),
  resetsAt: z.unknown().optional(),
});

/** 미디어 생성 한도 도달 429인가. 서버 문구 "미디어 생성 한도 도달, 운영진 문의"나 옛 서버의 한도 칸으로 알아본다(요청 횟수 제한 429와 구분) */
function limitReached(status: number, body: z.infer<typeof MediaFailureBody>): boolean {
  return status === 429 && ((body.message ?? "").includes("미디어 생성 한도") || body.dailyLimit !== undefined || body.remainingToday !== undefined || body.resetsAt !== undefined);
}

/** 429(미디어 생성 한도 도달)일 때 서버 message 대신 전하는 한 줄 */
const LIMIT_REACHED = "미디어 생성 한도에 도달했다. 운영진에게 문의하도록 사용자에게 알린다.";

/** ISO 시각을 한국 시간 `2026년 10월 30일 00:00`으로 쓴다. 읽지 못하면 받은 문자열 그대로다 */
export function koreanTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const kst = new Date(time + 9 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

/** 상태별 기본 문구. 서버가 message를 주면 그것을 먼저 쓴다 */
function fallback(kind: MediaKind, status: number): string | undefined {
  const { noun, obj } = LABEL[kind];
  const texts: Record<number, string> = {
    400:
      kind === "image"
        ? "이미지 요청 내용을 확인하지 못했습니다. 설명을 4000자 안으로 줄이고 크기는 1024x1024, 1536x1024, 1024x1536 중에서 선택해 주세요."
        : "영상 요청 내용을 확인하지 못했습니다. 설명을 4000자 안으로 줄이고 길이, 해상도, 화면 비율을 정해진 값에서 선택해 주세요.",
    403: `${obj} 만들 수 있는 교육이 없습니다. 이 교육에서 ${noun} 생성을 쓰지 않거나 참여 중인 교육이 없습니다. 교육 담당자에게 문의해 주세요.`,
    404: kind === "image" ? "이미지 만들기를 쓸 수 없습니다. Apps 로그인과 플러그인 버전을 확인해 주세요." : "영상 작업을 찾지 못했습니다. 작업 ID와 Apps 로그인, 플러그인 버전을 확인해 주세요.",
    409: `${obj} 이미 만들고 있습니다. 끝난 뒤 다시 요청해 주세요.`,
    502: kind === "image" ? "이미지를 만들지 못했습니다. 잠시 뒤 다시 요청해 주세요." : "영상 서비스에 연결하지 못했습니다. 잠시 뒤 다시 요청해 주세요.",
    503: `${noun} 만들기가 아직 준비되지 않았습니다. 교육 담당자에게 문의해 주세요.`,
  };
  return texts[status];
}

/** 다음 행동. 사용자에게 전할 문구가 아니라 클로드가 따를 안내다 */
function nextAction(kind: MediaKind, status: number, limit: boolean): string | undefined {
  const { noun } = LABEL[kind];
  const stop = `다시 시도하지 않는다. API 키를 묻거나 다른 ${noun} 서비스로 우회하지 않는다.`;
  const texts: Record<number, string> = {
    409:
      kind === "image"
        ? "자동으로 다시 시도하지 않는다. 앞 요청이 끝난 뒤 사용자가 원하면 다시 부른다."
        : "자동으로 다시 시도하지 않는다. 진행 중인 작업은 video_status로 확인하고, 끝난 뒤 사용자가 원하면 새로 접수한다.",
    429: limit ? `다시 시도하지 않는다. 다른 ${noun} 서비스나 API 키를 찾아 우회하지 않는다.` : "요청이 몰렸다. 잠시(1분쯤) 뒤 사용자가 원하면 다시 부른다. 다른 서비스나 API 키로 우회하지 않는다.",
    502: "자동으로 다시 시도하지 않는다. 사용자가 원하면 한 번 다시 부른다.",
    503: stop,
    403: stop,
  };
  return texts[status];
}

/** 실패 응답을 사용자에게 전할 문구로 바꾼다. 서버 message를 그대로 전하고, 없으면 상태별 기본 문구를 쓴다 */
export function mediaFailureText(kind: MediaKind, status: number, body: unknown): string {
  const parsed = MediaFailureBody.safeParse(body);
  const limit = parsed.success && limitReached(status, parsed.data);
  const message = limit ? LIMIT_REACHED : ((parsed.success ? parsed.data.message : undefined) ?? fallback(kind, status) ?? `${LABEL[kind].obj} 만들지 못했습니다(상태 ${status}).`);
  const next = nextAction(kind, status, limit);
  return [limit ? message : `사용자에게 그대로 전한다: ${message}`, ...(next === undefined ? [] : [next])].join("\n");
}
