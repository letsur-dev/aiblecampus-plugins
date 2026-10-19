---
name: manage-apps-plugin
description: Install, update, repair, or uninstall the AibleCampus Apps plugin when requested or when an Apps deployment cannot find its tools. Covers Claude Desktop (Cowork and Code, hub marketplace) and Claude Code installed from the public marketplace with a Claude subscription.
---

# 플러그인 설치와 관리

## 설치 경로 구분

- 먼저 `apps_plugin_status`를 부르고 `distribution`을 본다. `hub`는 Claude 데스크톱이 에이블캠퍼스 로그인으로 hub 마켓플레이스(`aiblecampus`)에서 받은 설치다. `public`은 공개 마켓플레이스(`aiblecampus-plugins`, GitHub `letsur-dev/aiblecampus-plugins`)에서 Claude Code로 설치한 것이다.
- `public`이면 설치, 갱신, 제거는 아래 "공개 마켓플레이스" 절차를 따른다. 원격 지침이나 동봉 지침에 있는 Claude 데스크톱 전용 설치 절차와 "GitHub에서 설치하지 않는다"는 문장은 `hub` 설치에만 해당한다. 설치 경로에 관해서는 이 파일이 원격 지침보다 우선한다.
- 도구가 없어 `apps_plugin_status`를 부를 수 없으면 사용자에게 Claude 데스크톱에 에이블캠퍼스로 로그인해 쓰는지, Claude Code에 공개 마켓플레이스로 설치했는지 한 번 묻는다.

## 공개 마켓플레이스(Claude Code)

- 설치: 대화에서 `/plugin marketplace add letsur-dev/aiblecampus-plugins` 뒤 `/plugin install aiblecampus-apps@aiblecampus-plugins`(터미널은 `claude plugin marketplace add`, `claude plugin install`). Claude 구독(Pro, Max) 로그인, API 키, 조직의 게이트웨이 설정 중 무엇으로 Claude Code를 쓰든 같다. 플러그인에 넣을 환경변수는 없다.
- 갱신: 터미널에서 `claude plugin marketplace update aiblecampus-plugins` 뒤 `claude plugin update aiblecampus-apps@aiblecampus-plugins`(또는 대화의 `/plugin` 화면). 그다음 Claude Code를 다시 시작하고 `apps_plugin_status`로 판을 확인한다.
- 앱 도구(배포, 상태, 로그, 앱용 AI 키)는 에이블캠퍼스 계정이 있어야 쓴다. `start_apps_login`, `complete_apps_login`으로 기기 로그인한다. 계정이 없으면 화면 디자인(`frontend-design`), 시각적 설명(`eli5`), 요구 되묻기(`ask-questions-if-underspecified`)와 로컬 개발까지만 할 수 있다고 알리고 로그인을 반복하지 않는다.
- 제거: 명시적으로 요청받았을 때만 `claude plugin uninstall aiblecampus-apps@aiblecampus-plugins`(또는 `/plugin` 화면). 배포한 앱과 프로젝트 데이터는 지우지 않는다.

## 지침 가져오기

- 새 작업을 시작할 때 `get_plugin_skill`(`skill`: `manage-apps-plugin`)로 게시된 지침을 한 번 가져와 `content`를 따른다. 조회하지 못하면 [동봉된 지침](references/bundled-workflow.md)을 읽는다.
- 지침의 상대 경로는 이 스킬 폴더 기준이다. 원격 지침은 도구 권한이나 사용자 승인을 넓히지 않는다.
