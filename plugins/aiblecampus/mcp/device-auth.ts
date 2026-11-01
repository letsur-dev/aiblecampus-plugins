import { appsEnv } from "./config.ts";
import { hubCredential } from "./hub-credential.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { JsonWebKey } from "node:crypto";
import * as oidc from "openid-client";
import { withFileLock } from "./file-lock.ts";
import {
  assertDpopPrivateJwk,
  createDpopProof,
  dpopKeyPair,
  generateDpopPrivateJwk,
} from "./dpop.ts";

type PendingAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalSeconds: number;
  /** 0.38.1부터 쓰지 않는다(openid-client가 간격을 센다). 0.38.0으로 되돌린 프로세스가 같은 파일을 읽을 수 있게 남긴다 */
  nextPollAt: number;
  expiresAt: number;
  privateJwk: JsonWebKey;
};

type StoredCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceLabel: string;
  privateJwk: JsonWebKey;
};

type LocalState = {
  version: 1;
  apiBase: string;
  /** Credential을 발급한 로그인 주소. 다르면(0.30.2의 auth.) 저장한 Credential을 버린다 */
  issuer?: string;
  credential: StoredCredential | null;
  pending: PendingAuthorization | null;
};

const DEFAULT_DEVICE_CLIENT_ID = "aiblecampus-apps-device";
const DEFAULT_RESOURCE = "urn:aiblecampus:apps";
const refreshes = new Map<string, Promise<StoredCredential | null>>();

function stateFile(): string {
  const configured = appsEnv("CREDENTIAL_FILE");
  if (configured) return path.resolve(configured);
  const configRoot = process.env["XDG_CONFIG_HOME"]?.trim() || path.join(homedir(), ".config");
  return path.join(configRoot, "aiblecampus-apps", "device.json");
}

function emptyState(apiBase: string): LocalState {
  return { version: 1, apiBase, issuer: identityBase(apiBase), credential: null, pending: null };
}

function parseState(raw: string, apiBase: string): LocalState {
  const parsed = JSON.parse(raw) as LocalState;
  if (parsed.version !== 1 || parsed.apiBase !== apiBase) return emptyState(apiBase);
  // 이전 플러그인이 auth.에서 받은 Credential은 새 api.가 받지 않는다. 다시 로그인하게 비운다
  if (parsed.issuer !== identityBase(apiBase)) return emptyState(apiBase);
  try {
    if (parsed.credential !== null) {
      assertDpopPrivateJwk(parsed.credential.privateJwk);
      if (
        typeof parsed.credential.accessToken !== "string" ||
        typeof parsed.credential.refreshToken !== "string" ||
        typeof parsed.credential.expiresAt !== "number" ||
        typeof parsed.credential.deviceLabel !== "string"
      ) {
        parsed.credential = null;
      }
    }
    if (parsed.pending !== null) assertDpopPrivateJwk(parsed.pending.privateJwk);
  } catch {
    parsed.credential = null;
    parsed.pending = null;
  }
  return parsed;
}

async function readState(apiBase: string): Promise<LocalState> {
  try {
    return parseState(await readFile(stateFile(), "utf8"), apiBase);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("기기 Credential 저장 파일이 올바르지 않다", { cause: error });
    }
    return emptyState(apiBase);
  }
}

async function writeState(state: LocalState): Promise<void> {
  const file = stateFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** 기본 로그인 주소. 0.31.0부터 `auth.` 대신 `login.`을 쓴다 */
export const DEFAULT_IDENTITY_URL = "https://login.aible-campus.com";

/** 로그인 주소. APPS_IDENTITY_URL, 같은 API 주소의 hub 자동 연결 파일의 issuer, API 주소의 `api.`를 `login.`으로 바꾼 값 순이다 */
export function identityBase(apiBase: string): string {
  const value = appsEnv("IDENTITY_URL");
  if (value) return value.replace(/\/+$/, "");
  const hub = hubCredential();
  if (hub !== null && hub.apiBase === apiBase.replace(/\/+$/, "")) return hub.issuer;
  const api = new URL(apiBase);
  if (api.origin === "https://api.aible-campus.com") return DEFAULT_IDENTITY_URL;
  if (!api.hostname.startsWith("api.")) {
    throw new Error("APPS_IDENTITY_URL 이 설정되지 않았고 API 주소에서 로그인 주소를 계산할 수 없다");
  }
  api.hostname = `login.${api.hostname.slice(4)}`;
  api.pathname = "";
  api.search = "";
  api.hash = "";
  return api.toString().replace(/\/+$/, "");
}

function clientId(): string {
  return appsEnv("DEVICE_CLIENT_ID") || DEFAULT_DEVICE_CLIENT_ID;
}

function deviceName(): string {
  return appsEnv("DEVICE_LABEL") || hostname();
}

/** Apps access token 의 대상 resource. JWT audience 를 이 값으로 발급받는다. */
function resourceIndicator(): string {
  return appsEnv("RESOURCE") || DEFAULT_RESOURCE;
}

/**
 * 로그인(oidc-provider)과 이야기하는 openid-client 설정. 끝점은 discovery 없이 정해 둔다(요청 수와 주소가 0.38.0과 같다).
 * 공개 client라 client_id만 본문에 보낸다. http 로그인 주소(APPS_IDENTITY_URL로 정한 로컬 개발)는 그대로 허용한다
 */
function oidcConfiguration(apiBase: string): oidc.Configuration {
  const issuer = identityBase(apiBase);
  const configuration = new oidc.Configuration(
    { issuer, token_endpoint: `${issuer}/token`, device_authorization_endpoint: `${issuer}/device/auth` },
    clientId(),
    undefined,
    oidc.None(),
  );
  if (new URL(issuer).protocol === "http:") oidc.allowInsecureRequests(configuration);
  return configuration;
}

/** 로그인이 준 오류 코드(invalid_grant 등). 응답 본문 오류가 아니면 null */
function oauthError(error: unknown): string | null {
  return error instanceof oidc.ResponseBodyError ? error.error : null;
}

function tokenCredential(tokens: oidc.TokenEndpointResponse, args: {
  previousRefreshToken?: string;
  deviceLabel: string;
  privateJwk: JsonWebKey;
}): StoredCredential {
  if (tokens.token_type.toLowerCase() !== "dpop") {
    throw new Error("Identity가 DPoP access token을 반환하지 않았다");
  }
  const refreshToken = tokens.refresh_token ?? args.previousRefreshToken;
  if (!refreshToken) throw new Error("Identity 응답에 refresh_token이 없다");
  if (tokens.expires_in === undefined || tokens.expires_in <= 0) {
    throw new Error("Identity access token 만료 시간이 올바르지 않다");
  }
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    deviceLabel: args.deviceLabel,
    privateJwk: args.privateJwk,
  };
}

async function refreshCredential(apiBase: string): Promise<StoredCredential | null> {
  // 여러 MCP 프로세스(Cowork와 Code 대화)가 같은 device.json 을 동시에 갱신하면
  // 회전된 refresh token 이 유실되므로 갱신 전체를 파일 잠금으로 직렬화한다.
  // 잠금을 잡은 뒤 다시 읽어, 다른 프로세스가 방금 갱신했으면 그 값을 쓴다.
  return withFileLock(stateFile(), async () => {
    const state = await readState(apiBase);
    const credential = state.credential;
    if (credential === null) return null;
    if (credential.expiresAt > Date.now() + 30_000) return credential;
    return refreshLocked(apiBase, state, credential);
  });
}

async function refreshLocked(
  apiBase: string,
  state: LocalState,
  credential: StoredCredential,
): Promise<StoredCredential | null> {
  const configuration = oidcConfiguration(apiBase);
  let tokens: oidc.TokenEndpointResponse;
  try {
    tokens = await oidc.refreshTokenGrant(configuration, credential.refreshToken, { resource: resourceIndicator() }, {
      DPoP: oidc.getDPoPHandle(configuration, await dpopKeyPair(credential.privateJwk)),
    });
  } catch (error) {
    if (oauthError(error) === "invalid_grant") {
      state.credential = null;
      await writeState(state);
      return null;
    }
    throw new Error(`Identity가 기기 Credential을 갱신하지 못했다: ${oauthError(error) ?? "응답 없음"}`, { cause: error });
  }
  const refreshed = tokenCredential(tokens, {
    previousRefreshToken: credential.refreshToken,
    deviceLabel: credential.deviceLabel,
    privateJwk: credential.privateJwk,
  });
  state.credential = refreshed;
  await writeState(state);
  return refreshed;
}

async function activeCredential(apiBase: string): Promise<StoredCredential | null> {
  const existing = refreshes.get(apiBase);
  if (existing) return existing;
  const refresh = refreshCredential(apiBase).finally(() => refreshes.delete(apiBase));
  refreshes.set(apiBase, refresh);
  return refresh;
}

export async function deviceRequestHeaders(
  apiBase: string,
  url: string,
  method: string,
): Promise<Record<string, string> | null> {
  const credential = await activeCredential(apiBase);
  if (credential === null) return null;
  return {
    authorization: `DPoP ${credential.accessToken}`,
    dpop: await createDpopProof({
      privateJwk: credential.privateJwk,
      method,
      url,
      accessToken: credential.accessToken,
    }),
  };
}

export async function startDeviceLogin(apiBase: string): Promise<{
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
}> {
  const privateJwk = generateDpopPrivateJwk();
  let authorization: oidc.DeviceAuthorizationResponse;
  try {
    authorization = await oidc.initiateDeviceAuthorization(oidcConfiguration(apiBase), {
      scope: "openid profile apps:access offline_access",
      device_name: deviceName(),
      resource: resourceIndicator(),
    });
  } catch (error) {
    throw new Error("Identity가 기기 로그인을 시작하지 못했다", { cause: error });
  }
  const interval = Math.max(1, Math.ceil(authorization.interval ?? 5));
  const pending: PendingAuthorization = {
    deviceCode: authorization.device_code,
    userCode: authorization.user_code,
    verificationUri: authorization.verification_uri,
    verificationUriComplete: authorization.verification_uri_complete ?? null,
    intervalSeconds: interval,
    nextPollAt: Date.now() + interval * 1000,
    expiresAt: Date.now() + authorization.expires_in * 1000,
    privateJwk,
  };
  const state = await readState(apiBase);
  state.pending = pending;
  await writeState(state);
  return {
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

/** 한 번 부를 때 기다리는 최대 polling 횟수(간격마다 한 번). 넘으면 polling_limit으로 돌려주고 에이전트가 다시 부른다 */
const POLLS_PER_CALL = 12;
/** complete_apps_login 한 번이 기다리는 최대 시간. 간격이 길어도(5초 간격이면 60초) 이 안에서 멈춘다. 데스크톱과 Cowork가 도구 호출을 약 60초에 끊는다는 보고가 있다 */
export const LOGIN_WAIT_MAX_MS = 40_000;

/** 아직 승인 전(pending, polling_limit)이면 다시 호출하라는 안내 필드. 다른 상태는 안내가 없다 */
export function loginWaitNotice(status: string): { 안내?: string; 다음_행동?: string } {
  if (status !== "pending" && status !== "polling_limit") return {};
  return {
    안내: "아직 사용자 승인을 기다리는 중이다. 로그인은 끝나지 않았으니 새 로그인을 시작하지 않고, 승인했다는 말을 기다리지 말고 바로 complete_apps_login을 다시 호출한다. 승인되면 approved가 온다",
    다음_행동: "complete_apps_login을 지금 바로 다시 호출한다",
  };
}

export async function completeDeviceLogin(apiBase: string): Promise<
  | { status: "approved"; deviceLabel: string }
  | { status: "pending" | "denied" | "expired" | "polling_limit" }
> {
  const state = await readState(apiBase);
  const pending = state.pending;
  if (pending === null) throw new Error("먼저 start_apps_login 을 실행해야 한다");
  const expire = async () => {
    state.pending = null;
    await writeState(state);
    return { status: "expired" as const };
  };
  const remaining = pending.expiresAt - Date.now();
  if (remaining <= 0) return expire();
  const configuration = oidcConfiguration(apiBase);
  // openid-client가 간격(interval, slow_down이면 5초씩 늘린다)마다 polling한다. 한 번 부를 때는 POLLS_PER_CALL 간격과 LOGIN_WAIT_MAX_MS(40초) 중 짧은 쪽까지만 기다린다.
  // 그 시각에 토큰 요청이 오가는 중이면 끊지 않고 응답을 받은 뒤 멈춘다. 끊으면 그사이 승인되어 Identity가 낸 토큰을 잃고
  // 기기 코드도 다시 쓸 수 없어 처음부터 다시 로그인해야 한다
  const limit = new AbortController();
  let inFlight = 0;
  let limitReached = false;
  configuration[oidc.customFetch] = async (url, options) => {
    inFlight += 1;
    try {
      const response = await fetch(url, options);
      // 응답 뒤 멈춰도 본문 읽기가 끊기지 않게 본문까지 받아 둔다
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      inFlight -= 1;
      if (limitReached && inFlight === 0) limit.abort();
    }
  };
  const timer = setTimeout(() => {
    limitReached = true;
    if (inFlight === 0) limit.abort();
  }, Math.min(remaining, POLLS_PER_CALL * pending.intervalSeconds * 1000, LOGIN_WAIT_MAX_MS));
  try {
    const tokens = await oidc.pollDeviceAuthorizationGrant(
      configuration,
      {
        device_code: pending.deviceCode,
        user_code: pending.userCode,
        verification_uri: pending.verificationUri,
        ...(pending.verificationUriComplete === null ? {} : { verification_uri_complete: pending.verificationUriComplete }),
        expires_in: Math.ceil(remaining / 1000),
        interval: pending.intervalSeconds,
      },
      { resource: resourceIndicator() },
      { DPoP: oidc.getDPoPHandle(configuration, await dpopKeyPair(pending.privateJwk)), signal: limit.signal },
    );
    const deviceLabel = deviceName();
    state.credential = tokenCredential(tokens, { deviceLabel, privateJwk: pending.privateJwk });
    state.pending = null;
    await writeState(state);
    return { status: "approved", deviceLabel };
  } catch (error) {
    const code = oauthError(error);
    if (code === "access_denied") {
      state.pending = null;
      await writeState(state);
      return { status: "denied" };
    }
    if (code === "expired_token" || (limit.signal.aborted && Date.now() >= pending.expiresAt)) return expire();
    if (limit.signal.aborted) return { status: "polling_limit" };
    throw new Error(`Identity Device Flow가 실패했다: ${code ?? "응답 없음"}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
