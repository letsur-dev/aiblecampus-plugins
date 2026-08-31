# 에이블캠퍼스 PaaS 플러그인

Claude Code와 Codex에서 웹앱을 완성하고 검증한 뒤 에이블캠퍼스 PaaS에 배포한다. 같은 배포 스킬과 MCP 도구를 두 클라이언트가 함께 사용한다.

## 지원 기능

- 요청한 웹앱 구현과 배포 가능 여부 검증
- 로컬 프로젝트와 public Git 저장소 배포
- 기존 앱의 같은 주소 유지 재배포
- 배포 중지와 영속 자원 정책을 지정한 삭제
- 배포 상태, 빌드 로그와 실행 로그 조회
- 일반 환경변수와 암호화된 비밀값 관리
- 하드코딩된 비밀값 설명과 승인 기반 로컬 env 정리
- 개인 및 Team Workspace 선택
- PostgreSQL과 파일 Storage 자동 연결
- SQLite, Compose PostgreSQL, 로컬 파일과 외부 관리형 자원의 읽기 전용 진단
- 사용자 승인, 백업, 미리보기, PostgreSQL과 Storage 실제 import를 거치는 안전한 영속 스택 전환
- Claude Code와 Codex 공통 작업 흐름

## 설치

이 저장소를 내려받은 폴더를 marketplace로 등록한 뒤 `aiblecampus-paas` 플러그인을 설치한다.

Claude Code에서는 저장소의 `.claude-plugin/marketplace.json`을 사용한다. Codex에서는 저장소의 `.agents/plugins/marketplace.json`을 사용한다.

Claude Code에서 설치나 갱신 뒤 새 Skill과 MCP가 현재 대화에 보이지 않으면 클라이언트를 종료하지 않고 입력창에서 `/reload-plugins`를 실행한다. `/reload-skills`만으로는 MCP가 바뀌지 않는다. Claude는 자기 입력창의 slash command를 직접 실행할 수 없으므로 사용자가 한 번 입력해야 하지만, 같은 대화와 요청은 그대로 유지된다. 재로딩 뒤 `paas_plugin_status`를 호출하면 설치 목록이 아니라 실제로 실행 중인 MCP 버전을 확인할 수 있다.

플랫폼 연결에는 다음 환경변수를 사용한다.

- `PAAS_API_URL`: 플랫폼 제어 API 주소. 생략하면 `https://api.aible-campus.com`을 사용한다.
- `PAAS_IDENTITY_URL`: Identity 주소. 생략하면 API 주소의 `api.`를 `auth.`로 바꿔 계산한다.
- `PAAS_DEVICE_CLIENT_ID`: Device Flow client ID. 기본값은 `aiblecampus-paas-device`다.
- `PAAS_OPEN_BROWSER`: Device Flow 승인 주소 자동 열기 여부. 기본값은 `1`이며 `0`, `false` 또는 `off`로 끌 수 있다.
- `PAAS_TOKEN`: 이전 운영 및 CI용 service Credential. 개인 기기 로그인보다 우선 적용된다.
- `PAAS_DEPLOYMENT_ATTEMPT_FILE`: 배포 요청 복구 파일을 별도 위치에 둘 때만 설정한다. 생략하면 사용자 설정 폴더 안에 저장한다.

Credential 원문은 프로젝트 파일, 커밋이나 대화에 기록하지 않는다. Claude Code 환경 설정을 바꾼 뒤에는 `/reload-plugins`로 현재 대화의 MCP를 다시 읽는다. Codex는 현재 클라이언트가 제공하는 플러그인 재로딩 절차를 사용한다.

로그인이 필요하면 `start_paas_login`이 승인 주소를 기본 브라우저에서 연다. Agent는 사용자에게 완료 응답을 요구하지 않고 `complete_paas_login`을 바로 호출해 승인 상태를 polling한다. 브라우저를 열 수 없는 환경에서만 주소와 코드를 직접 안내한다.

`deploy_project`는 동일한 소스와 설정의 요청 지문과 임의 멱등 키를 권한 0600인 로컬 파일에 30분 동안 보관한다. MCP가 재시작되거나 응답이 끊겨도 Agent는 먼저 `deployment_status`로 기존 작업을 확인하고, 필요하면 같은 요청을 보내 서버가 기존 Revision을 반환하게 한다. 소스, 설정값과 비밀값 원문은 복구 파일에 저장하지 않는다. 직전 Revision이 명확히 실패했고 새 빌드가 필요한 경우에만 `forceNewRevision`을 사용한다.

앱이 사용하는 비밀번호와 API 키는 Device Credential과 별개다. 플러그인은 소스에 직접 저장된 비밀값을 발견하면 원문을 반복하지 않고 위험과 최소 수정 내용을 설명한다. 사용자가 동의하면 Agent가 코드는 환경변수를 사용하도록 바꾸고 실제 값은 Git에서 제외한 `.env.local`로 옮긴다. 새로 필요한 사용자 지정 비밀번호는 Agent 세션에서 입력할 수 있으며 Agent는 받은 값을 후속 답변에서 되읽지 않는다.

`validate_project`와 `deploy_project`의 `localEnv`에는 파일 이름과 사용자가 승인한 키 이름만 전달한다. MCP는 선택한 키만 로컬 파일에서 읽어 PaaS 일반 설정 또는 암호화 비밀값으로 전달한다. 실제 env 파일은 소스 압축에서 제외하고 `.env.example`, `.env.sample`과 `env.example` 같은 키 예시는 유지한다.

플러그인은 Identity 계약 버전 1의 `/device/auth`와 `/token`을 사용하며
`urn:aiblecampus:paas` resource와 `paas:access` scope를 요청한다. 기기별 ES256
DPoP 키와 회전 refresh token은 권한이 0600인 로컬 Credential 파일에만 저장하고,
PaaS 요청마다 access token과 요청 URL 및 method를 새 proof로 묶는다.

## 현재 범위

Identity의 Device 승인, 기기 목록과 개별 회수는 지원한다. private Git 저장소 인증은 아직 제공하지 않는다. PostgreSQL과 파일 Storage는 앱 사용 코드를 감지해 배포별로 자동 연결하며 운영 Credential은 사용자에게 노출하지 않는다. 기존 SQLite와 로컬 파일은 승인 전까지 변경하지 않고 계획과 읽기 전용 미리보기만 제공하며, 승인 후 로컬 백업을 남기고 빈 PaaS 자원으로 실제 이전할 수 있다. Compose PostgreSQL과 외부 관리형 자원은 서비스별 수동 export 절차가 필요하다.
