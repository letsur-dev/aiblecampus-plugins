# 에이블캠퍼스 플러그인

에이블캠퍼스 Claude Code 플러그인 마켓플레이스다. 지금은 `aiblecampus-apps` 플러그인 하나를 둔다.

- 화면 디자인, 쉬운 시각적 설명, 요구 되묻기 스킬은 Claude에 로그인만 되어 있으면 쓴다. Claude 구독(Pro, Max), Anthropic API 키, 조직의 게이트웨이 설정 중 무엇이든 된다.
- 에이블캠퍼스 Apps 배포와 앱용 AI 키는 에이블캠퍼스 계정이 있어야 쓴다. 플러그인 안에서 기기 로그인으로 연결한다.
- 이 저장소는 에이블캠퍼스 허브 저장소의 `tools/apps-plugin`에서 만든 공개본이다. 여기서 직접 고치지 않는다.

## 설치(Claude Code)

Claude Code 대화에서 차례로 실행한다.

```text
/plugin marketplace add letsur-dev/aiblecampus-plugins
/plugin install aiblecampus-apps@aiblecampus-plugins
```

터미널에서는 다음과 같다.

```bash
claude plugin marketplace add letsur-dev/aiblecampus-plugins
claude plugin install aiblecampus-apps@aiblecampus-plugins
```

- 설치한 뒤 Claude Code를 다시 시작한다. 새 대화에서 "에이블캠퍼스 플러그인 상태 확인해줘"라고 하면 `apps_plugin_status`가 판과 설치 경로(`distribution: "public"`)를 알려 준다.
- 플러그인에 넣을 환경변수는 없다. Node.js 22.18 이상이 필요하다(MCP 서버 실행).

## 갱신과 제거

```bash
claude plugin marketplace update aiblecampus-plugins
claude plugin update aiblecampus-apps@aiblecampus-plugins
claude plugin uninstall aiblecampus-apps@aiblecampus-plugins
```

갱신한 뒤에는 Claude Code를 다시 시작한다. 제거해도 배포한 앱과 프로젝트 파일은 그대로다.

## Claude 데스크톱 교육 참가자

에이블캠퍼스 교육에서 Claude 데스크톱에 에이블캠퍼스로 로그인했다면 플러그인이 허브에서 자동으로 설치된다. 이 저장소로 따로 설치하지 않는다. 자세한 내용은 [플러그인 설명](plugins/aiblecampus-apps/README.md)에 있다.

## 라이선스

Letsur 소유이며 모든 권리를 보유한다([LICENSE](LICENSE)). 스킬 폴더 가운데 자체 라이선스 파일이 있는 것은 그 파일의 조건을 따른다.
