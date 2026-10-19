import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * hub 마켓플레이스가 플러그인 압축 파일에 넣은 자동 연결 Credential(0.37.0).
 *
 * Claude 데스크톱이 에이블캠퍼스 로그인으로 hub 마켓플레이스에서 플러그인을 자동 설치하면 플러그인 루트에
 * `aiblecampus-credential.json`({ version: 1, token: "amc_...", apiBase, issuer, expiresAt })이 있다.
 * MCP는 이 파일이 올바르고, 설정한 API 주소와 같고, 만료 전이면 `Authorization: Bearer amc_...`로 api.를 부른다(DPoP 없음).
 * 파일이 없거나, 만료됐거나, api.가 401로 거절하면 기기 로그인(start_apps_login)으로 넘어간다.
 * 파일의 apiBase와 issuer는 APPS_API_URL, APPS_IDENTITY_URL이 없을 때 이 설치의 기본 주소가 된다(스테이징 hub가 준 플러그인은 스테이징 api.를 부른다).
 */
const HUB_CREDENTIAL_FILE = "aiblecampus-credential.json";

export type HubCredential = { token: string; apiBase: string; issuer: string; expiresAt: number };

/** 만료 직전 토큰은 쓰지 않는다 */
const EXPIRY_MARGIN_MS = 60_000;
const rejected = new Set<string>();
let cached: HubCredential | null | undefined;

function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    return (url.protocol === "https:" || loopback) && url.origin === value;
  } catch {
    return false;
  }
}

/** 파일 내용을 읽는다. 형식이 틀리면 null */
export function parseHubCredential(raw: string): HubCredential | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const expiresAt = typeof value["expiresAt"] === "string" ? Date.parse(value["expiresAt"]) : Number.NaN;
    if (
      value["version"] !== 1 ||
      typeof value["token"] !== "string" ||
      !/^amc_[A-Za-z0-9_-]{43}$/.test(value["token"]) ||
      !isOrigin(value["apiBase"]) ||
      !isOrigin(value["issuer"]) ||
      !Number.isFinite(expiresAt)
    ) {
      return null;
    }
    return { token: value["token"], apiBase: value["apiBase"], issuer: value["issuer"], expiresAt };
  } catch {
    return null;
  }
}

/**
 * 플러그인 루트의 Credential 파일. 번들(dist/mcp.js)과 소스(mcp/hub-credential.ts) 모두 한 단계 위가 플러그인 루트다.
 * 기본 위치는 프로세스마다 한 번 읽는다(새 압축 파일이 설치되면 Claude가 MCP를 다시 띄운다)
 */
export function hubCredential(file?: string): HubCredential | null {
  if (file === undefined && cached !== undefined) return cached;
  let found: HubCredential | null;
  try {
    found = parseHubCredential(readFileSync(file ?? fileURLToPath(new URL(`../${HUB_CREDENTIAL_FILE}`, import.meta.url)), "utf8"));
  } catch {
    found = null;
  }
  if (file === undefined) cached = found;
  return found;
}

/** 이 API 주소에 지금 쓸 수 있는 Credential. 주소가 다르거나, 만료됐거나, 이 프로세스에서 api.가 거절했으면 null */
export function usableHubCredential(apiBase: string, now: number = Date.now(), file?: string): HubCredential | null {
  const credential = hubCredential(file);
  if (credential === null || credential.apiBase !== apiBase.replace(/\/+$/, "")) return null;
  if (credential.expiresAt <= now + EXPIRY_MARGIN_MS || rejected.has(credential.token)) return null;
  return credential;
}

/** api.가 401로 거절한 토큰. 이 프로세스에서는 다시 쓰지 않고 기기 로그인으로 넘어간다 */
export function rejectHubCredential(token: string): void {
  rejected.add(token);
}

/** 자동 연결이 끝났을 때 도구 결과에 붙이는 안내. 사용자에게는 따옴표 안 문장을 그대로 전한다 */
export const HUB_CREDENTIAL_RENEW_NOTICE =
  "에이블캠퍼스 자동 연결을 쓸 수 없어 기기 로그인으로 진행한다. 사용자에게 이렇게 안내한다: " +
  "\"자동 연결이 만료됐거나 해제됐어요. Claude에서 에이블캠퍼스로 다시 로그인하면 자동 연결이 새로 돼요. 지금은 기기 로그인으로 이어서 할게요.\" " +
  "그다음 start_apps_login과 complete_apps_login으로 로그인한다.";
