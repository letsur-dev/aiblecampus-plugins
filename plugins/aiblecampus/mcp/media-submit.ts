/**
 * 클로드에서 미디어 보관함 읽기와 미디어 제출(0.49.0, 2026-10-30). MCP 도구 `list_my_media`, `prepare_media_submission`, `submit_media_submission`이 쓴다.
 *
 * - 서버 계약은 `@aiblecampus/contracts/platform-api/media-library`다. 공개 저장소에서 따로 빌드하므로 허브 패키지를 가져오지 않고 한도와 응답 형식을 옮겼다. 값이 같은지는 단위 시험이 본다
 * - 세 도구는 구성 요소(묶음)가 아니다. 이미지·영상 생성 묶음이 켜지고 교육이 갤러리 기능을 쓸 때만 등록한다(도구 설정 파일의 `mediaSubmit`, 앱 기능과 앱 권한은 필요 없다)
 * - 모듈은 늘 사용자가 선택한다. 선택하지 않았거나 모르면 서버가 낼 수 있는 미디어 모듈 목록만 주고 아무것도 만들지 않는다(갤러리 제출의 보드 선택 규칙과 같다)
 * - 제출은 두 단계다. 미리보기(draftId는 서버가 저장하지 않는 서명 토큰, 30분)를 사용자에게 보여 주고 사용자가 다음 메시지에서 승인하면 같은 draftId로 확정한다
 */
import { z } from "zod";
import { koreanTime } from "./media-failure.ts";

export const MEDIA_SUBMIT_TITLE_MAX = 120;
export const MEDIA_SUBMIT_SUMMARY_MAX = 120;
/** 모듈 설정에서 정할 수 있는 개수 최댓값(서버 계약 MEDIA_SUBMIT_MAX_LIMIT) */
export const MEDIA_SUBMIT_MAX_LIMIT = 30;
export const MEDIA_CLAUDE_LIMIT_DEFAULT = 20;
export const MEDIA_CLAUDE_LIMIT_MAX = 50;
export const MEDIA_KINDS = ["image", "video"] as const;
export const MEDIA_MODULE_UNITS = ["any", "person", "team"] as const;

const uuid = z.string().uuid();
const KIND_LABEL = { image: "이미지", video: "영상" } as const;
const UNIT_LABEL = { any: "개인 또는 조", person: "개인", team: "조" } as const;

const Education = z.looseObject({ id: uuid, name: z.string(), ended: z.boolean(), endedAt: z.string().nullable().optional() });

export const MediaItem = z.looseObject({
  id: uuid,
  kind: z.enum(MEDIA_KINDS),
  prompt: z.string(),
  model: z.string(),
  createdAt: z.string(),
  size: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  resolution: z.string().nullable(),
  aspectRatio: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  bytes: z.number().nullable(),
  submissions: z.array(z.looseObject({ submissionId: uuid, moduleId: uuid, moduleName: z.string() })),
});
export type MediaItem = z.infer<typeof MediaItem>;

export const MediaList = z.looseObject({ education: Education, items: z.array(MediaItem), nextCursor: z.string().nullable() });
export const MediaEducations = z.looseObject({ educations: z.array(Education), guide: z.string().optional() });

/** 교육 한 줄. list_my_file_educations의 교육 사실(educationFact)과 같은 모양이다 */
export function mediaEducationFact(education: z.infer<typeof Education>): Record<string, unknown> {
  return { id: education.id, 이름: education.name, 종료됨: education.ended };
}

const ModuleOption = z.looseObject({
  key: z.string(),
  name: z.string(),
  unit: z.enum(MEDIA_MODULE_UNITS),
  mediaMin: z.number().int().min(1),
  mediaMax: z.number().int().min(1),
  closesAt: z.string(),
});
type ModuleOption = z.infer<typeof ModuleOption>;

export const MediaDraftAnswer = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("module-required"), message: z.string(), modules: z.array(ModuleOption) }),
  z.looseObject({ status: z.literal("team-required"), message: z.string(), module: ModuleOption, teams: z.array(z.looseObject({ id: uuid, name: z.string() })) }),
  z.looseObject({
    status: z.literal("draft"),
    draftId: z.string().min(40),
    expiresAt: z.string(),
    module: ModuleOption,
    owner: z.looseObject({ kind: z.enum(["person", "team"]), name: z.string() }),
    title: z.string(),
    summary: z.string(),
    media: z.array(z.looseObject({ id: uuid, kind: z.enum(MEDIA_KINDS), position: z.number().int(), representative: z.boolean(), prompt: z.string(), model: z.string(), ownerName: z.string().nullable() })),
    message: z.string(),
  }),
]);

export const MediaSubmitted = z.looseObject({
  submitted: z.literal(true),
  alreadySubmitted: z.boolean(),
  submissionId: uuid,
  module: z.looseObject({ key: z.string(), name: z.string() }),
  title: z.string(),
  mediaCount: z.number().int(),
  url: z.string(),
  message: z.string(),
});

export function mediaQuery(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** 목록 항목을 도구 결과로 옮긴다. 이미지 크기와 영상 길이, 어느 모듈에 냈는지 */
export function mediaItemFact(item: MediaItem): Record<string, unknown> {
  const format =
    item.kind === "image"
      ? { 크기: item.size ?? (item.width !== null && item.height !== null ? `${item.width}x${item.height}` : null) }
      : { 길이_초: item.durationSeconds, 해상도: item.resolution, 화면_비율: item.aspectRatio };
  return {
    id: item.id,
    종류: KIND_LABEL[item.kind],
    프롬프트: item.prompt,
    모델: item.model,
    만든_시각: koreanTime(item.createdAt),
    ...format,
    ...(item.bytes === null ? {} : { 파일_크기_바이트: item.bytes }),
    제출한_모듈: item.submissions.map((submission) => submission.moduleName),
  };
}

/** 낼 수 있는 모듈 한 줄 */
export function moduleOptionFact(option: ModuleOption): Record<string, unknown> {
  return { key: option.key, 이름: option.name, 제출_단위: UNIT_LABEL[option.unit], 최소: option.mediaMin, 최대: option.mediaMax, 마감: koreanTime(option.closesAt) };
}

/** 사용자에게 모듈을 묻고 응답을 끝내게 하는 지침(갤러리 제출의 보드 선택 규칙과 같다) */
export const MODULE_ASK_INSTRUCTIONS =
  "모듈 목록(이름, 개수 범위, 제출 단위, 마감)을 사용자에게 보여 주고 \"어느 모듈에 낼까요?\"라고 묻고 응답을 끝낸다. 모듈이 하나뿐이어도 대신 선택하지 않고 사용자가 확인하게 한다. 사용자가 선택하면 같은 내용과 선택한 모듈의 key를 moduleKey로 넣어 prepare_media_submission을 다시 호출한다. 아무것도 제출하지 않았다.";

export const TEAM_ASK_INSTRUCTIONS =
  "조 목록(이름)을 사용자에게 보여 주고 \"어느 조 명의로 낼까요?\"라고 묻고 응답을 끝낸다. 대신 선택하지 않는다. 사용자가 선택하면 같은 내용에 그 조의 id를 owner로 넣어 prepare_media_submission을 다시 호출한다. 아무것도 제출하지 않았다.";

/** 미리보기 지침. 사용자에게 보여 줄 것과 승인 규칙 */
export const DRAFT_INSTRUCTIONS = [
  "미리보기(모듈, 제출 명의, 제목, 한 줄 소개, 미디어 순서와 프롬프트, 대표)를 고쳐 쓰지 말고 그대로 사용자에게 보여 준다. 첫 번째 미디어가 대표다",
  "\"이대로 모듈에 제출할까요?\"라고 묻고 응답을 끝낸다",
  "사용자가 다음 메시지에서 분명히 승인할 때만 이 draftId와 approvedByUser: true로 submit_media_submission을 호출한다",
  "이 흐름을 시작한 \"제출해줘\" 같은 요청은 미리보기 승인이 아니다. 승인 전에는 제출하지 않는다",
  "사용자가 선택을 바꾸거나 순서, 제목을 고쳐 달라고 하면 고친 내용으로 prepare_media_submission을 다시 호출해 새 미리보기와 새 draftId를 받는다. 이전 draftId는 쓰지 않는다",
];
