import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hubCredential } from "./hub-credential.ts";

/**
 * 이 플러그인이 어디서 설치됐는지(0.40.1).
 *
 * - `hub`: hub 마켓플레이스(`aiblecampus`)가 사람별로 만든 압축 파일. 압축 파일 안 `plugin.json` 판에 `+hub.<12자리>`가 붙고(packages/domain/src/gateway/plugin-marketplace.ts),
 *   MCP 서버를 켠 교육이면 자동 연결 파일(aiblecampus-credential.json)도 있다. Claude 데스크톱이 에이블캠퍼스 로그인으로 받는다
 * - `public`: 공개 마켓플레이스(GitHub letsur-dev/aiblecampus-plugins). Claude Code에서 사용자의 Claude 구독(Pro, Max) 로그인 등으로 쓰고
 *   자동 연결 파일이 없으므로 앱 도구는 기기 로그인(start_apps_login)으로 쓴다. 공개본 `plugin.json` 판에는 `+hub.`가 없다
 * - `unknown`: `plugin.json`을 읽지 못했다(번들만 따로 실행한 시험 등)
 *
 * 설치, 갱신, 제거 절차가 경로마다 다르므로 manage-apps-plugin 스킬이 apps_plugin_status의 이 값으로 고른다
 */
export type PluginDistribution = "hub" | "public" | "unknown";

/** `plugin.json` 판과 자동 연결 파일 유무로 정한다 */
export function distributionOf(manifestVersion: string | null, hasHubCredential: boolean): PluginDistribution {
  if (hasHubCredential || (manifestVersion !== null && /\+hub\./.test(manifestVersion))) return "hub";
  return manifestVersion === null ? "unknown" : "public";
}

/** 플러그인 루트(`dist/mcp.js`의 한 단계 위)의 `.claude-plugin/plugin.json` 판. 없거나 형식이 틀리면 null */
export function manifestVersion(file: string = fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url))): string | null {
  try {
    const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

let cached: PluginDistribution | undefined;

/** 이 프로세스의 설치 경로. 프로세스마다 한 번 정한다(새 판이 설치되면 Claude가 MCP를 다시 띄운다) */
export function pluginDistribution(): PluginDistribution {
  cached ??= distributionOf(manifestVersion(), hubCredential() !== null);
  return cached;
}
