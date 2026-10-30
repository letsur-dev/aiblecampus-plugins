# 에이블캠퍼스 Apps 플러그인

웹앱의 화면 디자인, 쉬운 시각적 설명, AI 기능 개발을 돕고 사용자가 요청하면 에이블캠퍼스 Apps에 배포한다. 배포는 명시적으로 요청받았을 때만 한다.

## 두 가지 설치 경로

| 경로 | 대상 | Claude 로그인 | Apps 연결 |
| --- | --- | --- | --- |
| 공개 마켓플레이스(이 저장소) | Claude Code | Claude 구독(Pro, Max), API 키, 조직 게이트웨이 중 아무것 | 기기 로그인(`start_apps_login`) |
| 허브 마켓플레이스 | 교육 참가자의 Claude 데스크톱 | 에이블캠퍼스 로그인 | 자동 연결 |

`apps_plugin_status`의 `distribution`이 `public`이면 공개 마켓플레이스, `hub`이면 허브 마켓플레이스 설치다. 설치와 갱신 방법은 [저장소 안내](../../README.md)에 있다.

## 로그인 없이 쓰는 것

에이블캠퍼스 계정이 없어도 아래는 동작한다.

| 구성 요소 | 내용 |
| --- | --- |
| `frontend-design` 스킬 | 화면 제작과 디자인 개선 |
| `eli5` 스킬 | 구조와 데이터 흐름을 그림으로 쉽게 설명 |
| `ask-questions-if-underspecified` 스킬 | 요구가 모호할 때 먼저 되묻기 |
| `build-ai-feature` 스킬 | AI 기능 구현. 에이블캠퍼스 계정이 없으면 사용자가 가진 AI 제공자 API 키를 `.env.local`에 두고 구현한다(`get_ai_gateway`가 이 길을 안내한다) |
| `manage-apps-plugin` 스킬 | 설치, 갱신, 제거 안내 |
| `apps_plugin_status` | 실행 중인 판, API 주소, 인증 방식, 설치 경로 |
| `get_plugin_skill` | 게시된 최신 스킬 지침. 로그인이 없으면 동봉 지침을 쓰라고 답한다 |
| `preview_sqlite_transition`, `preview_local_files_transition` | SQLite와 로컬 파일 이전의 읽기 전용 미리보기 |

Claude 구독은 Claude Code 안에서만 쓰는 로그인이다. 만드는 앱의 서버가 부를 API 키로 쓸 수 없다.

## 에이블캠퍼스 로그인이 필요한 것

아래 도구는 `api.aible-campus.com`을 부르며 에이블캠퍼스 계정과 기기 로그인이 필요하다. 로그인이 없으면 `start_apps_login`으로 로그인하라는 오류를 돌려준다.

| 묶음 | 도구 |
| --- | --- |
| 로그인 | `start_apps_login`, `complete_apps_login` |
| 계정과 공간 | `apps_whoami`, `list_educations`, `list_deployment_organizations`, `list_deployments` |
| 검증과 배포 | `validate_project`, `deploy_project`, `deployment_status`, `deployment_logs`, `checkout_app_source` |
| 설정과 관리 | `deployment_config`, `set_deployment_config`, `stop_deployment`, `move_deployment`, `delete_deployment` |
| 데이터 이전 | `migrate_sqlite_data`, `migrate_local_files` |
| 앱용 AI 환경 | `get_ai_gateway`, `configure_ai_gateway` |

`verify_ai_gateway`는 에이블캠퍼스에 로그인하지 않고 프로젝트의 `.env.apps-ai`로 AI 게이트웨이에 짧은 요청을 보낸다. 그 파일은 `configure_ai_gateway`가 만들므로 실제로는 로그인한 뒤에 쓴다.

## 기기 로그인

- `start_apps_login`이 승인 주소를 기본 브라우저에서 열고 `complete_apps_login`이 승인을 기다린다. 브라우저를 열 수 없으면 주소와 코드를 직접 안내한다.
- 기기별 DPoP 키와 refresh token은 사용자 설정 폴더의 `aiblecampus-apps/device.json`(권한 0600)에만 저장한다. 원문을 프로젝트 파일, 커밋, 대화에 남기지 않는다.

## 환경변수(선택)

설정하지 않아도 된다. 개발용 서버에 붙일 때만 쓴다.

| 이름 | 기본값 |
| --- | --- |
| `APPS_API_URL` | `https://api.aible-campus.com` |
| `APPS_IDENTITY_URL` | 운영 API면 `https://login.aible-campus.com`, 그 밖에는 API 주소의 `api.`를 `login.`으로 바꾼 값 |
| `APPS_DEVICE_CLIENT_ID` | 에이블캠퍼스 기기 로그인 클라이언트 |
| `APPS_OPEN_BROWSER` | `1`. `0`, `false`, `off`면 승인 주소를 자동으로 열지 않는다 |
| `APPS_DEVICE_LABEL` | 이 컴퓨터의 이름(기기 목록에 보이는 이름) |
| `APPS_CREDENTIAL_FILE` | 사용자 설정 폴더의 `aiblecampus-apps/device.json` |
| `APPS_DEPLOYMENT_ATTEMPT_FILE`, `APPS_DELETE_CONFIRMATION_FILE` | 사용자 설정 폴더 안 |

Claude Code의 `ANTHROPIC_*` 설정은 플러그인과 관계없다. 구독 로그인이든 게이트웨이든 플러그인은 같게 동작한다.

## Auto 권한 모드

`hooks/`는 Claude Code mod다. Auto 권한 모드에서 배포 흐름 도구(`apps_plugin_status`, `apps_whoami`, `list_educations`, `list_deployment_organizations`, `list_deployments`, `validate_project`, `deploy_project`, `deployment_status`, `deployment_logs`, `checkout_app_source`)에 따로 정한 규칙이 없을 때만 허용으로 바꾼다. deny 규칙과 훅의 거절은 그대로다. 삭제, 중지, 이동, 데이터 이전, 설정, AI 키, 로그인 도구는 넣지 않았다.

## 파일 구성

- `dist/mcp.js`: MCP 서버 번들. `mcp/` 소스를 `npm ci && npm run build`로 다시 만들 수 있다.
- `skills/`: 스킬. `frontend-design`, `eli5`, `ask-questions-if-underspecified`는 원본 저장소의 파일을 고치지 않고 넣었다. 출처, 고정 커밋, 라이선스는 각 폴더의 `NOTICE.md`와 라이선스 파일에 있다.
- `hooks/`: Auto 권한 모드 mod.
