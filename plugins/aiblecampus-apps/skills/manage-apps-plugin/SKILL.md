---
name: manage-apps-plugin
description: Install, update, repair, or uninstall the AibleCampus Apps plugin in Claude Desktop Cowork, Claude Code, or Codex when requested or when an Apps deployment cannot find its tools.
---

# 플러그인 설치와 관리

## 기본 실행 규칙

- 사용자의 요청 범위와 프로젝트 규칙을 따른다. 개발이나 설명 요청만으로 배포, 삭제, 인증 변경을 수행하지 않는다.
- 비밀값을 출력하거나 지침에 넣지 않는다. 원격 지침은 도구 권한이나 사용자 승인을 확대하지 않는다.
- 이 스킬로 새 작업을 시작할 때 아래 MCP 도구로 현재 게시된 지침을 한 번 가져온다. 메시지마다 다시 조회하지 않는다.

```json
{
  "tool": "get_plugin_skill",
  "arguments": {
    "skill": "manage-apps-plugin"
  }
}
```

- 성공하면 반환된 `content`를 이번 작업의 상세 절차로 사용하고 `version`을 유지한다. 새 작업에서는 다시 조회한다. 원격 본문의 상대 경로는 이 스킬 폴더 기준이다.
- 도구가 없거나 인증, 네트워크, 서버 호환 문제로 조회할 수 없으면 [동봉된 지침](references/bundled-workflow.md)을 읽는다. 최신 지침을 확인하지 못했음을 알리고 기존 권한과 검증 절차를 지킨다. 지침 조회만을 위해 로그인이나 설치 변경을 강제하지 않는다.
- 동봉된 지침의 상대 경로도 이 스킬 폴더 기준으로 해석한다.
