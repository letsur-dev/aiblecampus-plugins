/**
 * 실패 응답을 도구 결과로 바꾼다(0.42.1).
 * - 결과는 사실만 담은 짧은 JSON이다(실패, 상태, 원인, 응답, 참고). 모델 행동을 지시하는 문장을 넣지 않는다.
 *   0.42.0까지는 404 결과 끝에 지시문을 붙였고 클로드가 이것을 도구 응답에 끼워 넣은 지시로 보고 사용자에게 경고했다(2026-10-21 클로드앱 실기 D2)
 * - JSON 본문은 아래 필드만 옮긴다. stage, details는 deploy-to-apps 지침(deployment-contract.md)이, educations는 education-required 거절에서 고를 교육 목록으로 읽는다
 * - JSON이 아닌 본문(HTML 오류 페이지 등)은 넣지 않고 길이만 적는다. 0.42.0까지는 `api.` 앞단의 404 HTML 전체가 도구 결과에 들어갔다
 */

export type JsonRecord = Record<string, unknown>;

export type ApiResult = {
  ok: boolean;
  status: number;
  body: JsonRecord | string;
};

/** 실패 응답 JSON에서 도구 결과로 옮기는 필드 */
const FAILURE_FIELDS = ["error", "code", "message", "stage", "details", "educations", "reason", "requestId"] as const;

/** message가 이보다 길면 자른다 */
export const FAILURE_MESSAGE_MAX = 2000;

/** 상태 코드별 원인 한 줄 */
const STATUS_CAUSE: Record<number, string> = {
  400: "요청 값이 거절됐다",
  403: "접근 권한이 없다",
  404: "대상이 없거나 접근 권한이 없다",
  405: "이 주소가 요청 방식을 받지 않는다",
  409: "현재 상태와 맞지 않아 거절됐다",
  410: "확인 기한이 지났다",
  413: "요청이 너무 크다",
  429: "요청이 너무 많다",
  500: "서버 오류다",
  502: "서버가 응답하지 않았다",
  503: "서버를 지금 쓸 수 없다",
  504: "서버 응답 시간이 지났다",
};

export function failureCause(status: number): string {
  return STATUS_CAUSE[status] ?? (status >= 500 ? "서버 오류다" : status >= 200 && status < 300 ? "응답 형식이 올바르지 않다" : "요청이 실패했다");
}

/** 실패 응답 본문에서 도구 결과에 넣을 부분. JSON이 아니면 본문 대신 길이만 적은 문장이다 */
export function failureBody(body: JsonRecord | string): JsonRecord | string | undefined {
  if (typeof body === "string") {
    const length = body.trim().length;
    return length === 0 ? undefined : `JSON이 아닌 응답이라 본문(${length}자)은 넣지 않았다`;
  }
  const picked: JsonRecord = {};
  for (const field of FAILURE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    picked[field] = field === "message" && typeof value === "string" && value.length > FAILURE_MESSAGE_MAX
      ? `${value.slice(0, FAILURE_MESSAGE_MAX)}...(${value.length}자 중 앞부분)`
      : value;
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}

/** 실패 응답 하나를 사실만 담은 구조로 바꾼다. note는 사실 서술 한 줄이다(지시문을 넣지 않는다) */
export function failureFacts(prefix: string, result: Pick<ApiResult, "status" | "body">, note?: string): JsonRecord {
  const body = failureBody(result.body);
  return {
    실패: prefix,
    상태: result.status,
    원인: failureCause(result.status),
    ...(body === undefined ? {} : { 응답: body }),
    ...(note === undefined ? {} : { 참고: note }),
  };
}
