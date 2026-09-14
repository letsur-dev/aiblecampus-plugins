# Letsur Gateway 구현 기준

2026-09-15에 확인한 [공식 API 가이드](https://docs.platform.letsur.ai/ai-gateway/api-reference)를 기준으로 한다. 구현할 기능의 세부 계약은 아래 해당 문서에서 확인한다.

## 인증과 URL

- [인증](https://docs.platform.letsur.ai/ai-gateway/api-reference/authentication): OpenAI 호환 SDK의 baseURL은 `LETSUR_BASE_URL`이며 현재 `https://gw.letsur.ai/v1`이다. Bearer 인증은 서버의 `LETSUR_API_KEY`를 사용한다.
- [Messages](https://docs.platform.letsur.ai/ai-gateway/api-reference/endpoints/messages): Anthropic SDK는 `/v1` 없는 origin을 사용한다. 직접 HTTP 요청은 `/v1/messages`에 `x-api-key`와 `anthropic-version: 2023-06-01`을 넣는다.
- 브라우저와 서버의 경계는 동일 출처 앱 API다. Gateway 키와 Portal 서비스 인증은 public 환경변수나 클라이언트 코드에 넣지 않는다.

## 기능별 계약

| 기능 | 공식 문서 | 구현 확인 |
| --- | --- | --- |
| 텍스트 대화 | [Chat Completions](https://docs.platform.letsur.ai/ai-gateway/api-reference/endpoints/chat-completions) | `/chat/completions`에 model과 messages를 전달하고 `choices[0].message.content`를 읽는다. finish_reason도 검사한다. |
| Responses | [Responses](https://docs.platform.letsur.ai/ai-gateway/api-reference/endpoints/responses) | `/responses`의 input과 output 계약을 따른다. Chat 응답 구조로 읽지 않는다. |
| 검색 벡터 | [Embeddings](https://docs.platform.letsur.ai/ai-gateway/api-reference/endpoints/embeddings) | 텍스트 생성 모델과 구분하고 벡터 차원을 저장소와 맞춘다. |
| 이미지 | [Image Generations](https://docs.platform.letsur.ai/ai-gateway/api-reference/endpoints/image-generations) | 선택한 모델의 지원 API를 확인한다. Gemini 이미지 모델은 Chat Completions의 `message.images`를 사용한다. |
| 모델 목록 | [Models](https://docs.platform.letsur.ai/ai-gateway/api-reference/endpoints/models) | MCP가 페이지네이션을 순회한다. 목록 응답은 지원 엔드포인트, 가격이나 잔여 한도를 보증하지 않는다. |

## 응답과 실패

- 텍스트 기능은 비스트리밍으로 구현을 시작해 실제 연결을 확인한다. 스트리밍이 필요하면 SSE를 사용하고 chunk 경계와 JSON 경계를 동일시하지 않는다. `[DONE]` 전에 끊긴 결과는 부분 응답으로 표시한다. 사용자가 취소하면 upstream도 중단한다.
- `finish_reason=length`는 잘린 응답, `content_filter`는 차단, `tool_calls`는 도구 실행 요청이다. 모델이 제안한 도구 호출을 임의 코드나 셸 명령으로 실행하지 않는다.
- [공통 오류](https://docs.platform.letsur.ai/ai-gateway/api-reference/errors)는 HTTP 상태, `type`, `error_ref`를 기준으로 진단한다. upstream의 detail을 그대로 사용자 화면이나 로그로 전파하지 않는다.
- 401은 인증, 402는 유닛, 429 `usage_limit_exceeded`는 월 한도 문제다. 같은 요청을 반복하지 않는다. 429 `rate_limit_exceeded`는 Retry-After를 따르고 재시도 횟수를 제한한다. 접수 여부를 모르는 생성 요청과 끊긴 스트림은 자동 재전송하지 않는다.
