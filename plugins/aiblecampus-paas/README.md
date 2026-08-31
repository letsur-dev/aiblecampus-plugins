# 에이블캠퍼스 PaaS 플러그인

Claude Code와 Codex에서 웹앱을 완성하고 검증한 뒤 에이블캠퍼스 PaaS에 배포한다. 같은 배포 스킬과 MCP 도구를 두 클라이언트가 함께 사용한다.

## 지원 기능

- 요청한 웹앱 구현과 배포 가능 여부 검증
- 로컬 프로젝트와 public Git 저장소 배포
- 기존 앱의 같은 주소 유지 재배포
- 배포 중지와 영속 자원 정책을 지정한 삭제
- 배포 상태, 빌드 로그와 실행 로그 조회
- 일반 환경변수와 암호화된 비밀값 관리
- 개인 및 Team Workspace 선택
- PostgreSQL과 파일 Storage 자동 연결
- SQLite, Compose PostgreSQL, 로컬 파일과 외부 관리형 자원의 읽기 전용 진단
- 사용자 승인, 백업, 미리보기, PostgreSQL과 Storage 실제 import를 거치는 안전한 영속 스택 전환
- Claude Code와 Codex 공통 작업 흐름

## 설치

이 저장소를 내려받은 폴더를 marketplace로 등록한 뒤 `aiblecampus-paas` 플러그인을 설치한다.

Claude Code에서는 저장소의 `.claude-plugin/marketplace.json`을 사용한다. Codex에서는 저장소의 `.agents/plugins/marketplace.json`을 사용한다.

플랫폼 연결에는 다음 환경변수를 사용한다.

- `PAAS_API_URL`: 플랫폼 제어 API 주소. 생략하면 현재 nip.io 운영 주소를 사용한다.
- `PAAS_IDENTITY_URL`: Identity 주소. 생략하면 API 주소의 `api.`를 `auth.`로 바꿔 계산한다.
- `PAAS_DEVICE_CLIENT_ID`: Device Flow client ID. 기본값은 `aiblecampus-paas-device`다.
- `PAAS_TOKEN`: 이전 운영 및 CI용 service Credential. 개인 기기 로그인보다 우선 적용된다.

Credential 원문은 프로젝트 파일, 커밋이나 대화에 기록하지 않는다. 값을 설정한 뒤 사용하는 클라이언트를 다시 시작한다.

플러그인은 Identity 계약 버전 1의 `/device/auth`와 `/token`을 사용하며
`urn:aiblecampus:paas` resource와 `paas:access` scope를 요청한다. 기기별 ES256
DPoP 키와 회전 refresh token은 권한이 0600인 로컬 Credential 파일에만 저장하고,
PaaS 요청마다 access token과 요청 URL 및 method를 새 proof로 묶는다.

## 현재 범위

Identity의 Device 승인, 기기 목록과 개별 회수는 지원한다. private Git 저장소 인증은 아직 제공하지 않는다. PostgreSQL과 파일 Storage는 앱 사용 코드를 감지해 배포별로 자동 연결하며 운영 Credential은 사용자에게 노출하지 않는다. 기존 SQLite와 로컬 파일은 승인 전까지 변경하지 않고 계획과 읽기 전용 미리보기만 제공하며, 승인 후 로컬 백업을 남기고 빈 PaaS 자원으로 실제 이전할 수 있다. Compose PostgreSQL과 외부 관리형 자원은 서비스별 수동 export 절차가 필요하다.
