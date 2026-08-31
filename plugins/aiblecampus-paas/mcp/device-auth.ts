import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { JsonWebKey } from "node:crypto";
import { withFileLock } from "./file-lock.ts";
import {
  assertDpopPrivateJwk,
  createDpopProof,
  generateDpopPrivateJwk,
} from "./dpop.ts";

type PendingAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalSeconds: number;
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
  credential: StoredCredential | null;
  pending: PendingAuthorization | null;
};

const DEFAULT_DEVICE_CLIENT_ID = "aiblecampus-paas-device";
const DEFAULT_RESOURCE = "urn:aiblecampus:paas";
const refreshes = new Map<string, Promise<StoredCredential | null>>();

function stateFile(): string {
  const configured = process.env["PAAS_CREDENTIAL_FILE"]?.trim();
  if (configured) return path.resolve(configured);
  const configRoot = process.env["XDG_CONFIG_HOME"]?.trim() || path.join(homedir(), ".config");
  return path.join(configRoot, "aiblecampus-paas", "device.json");
}

function emptyState(apiBase: string): LocalState {
  return { version: 1, apiBase, credential: null, pending: null };
}

function parseState(raw: string, apiBase: string): LocalState {
  const parsed = JSON.parse(raw) as LocalState;
  if (parsed.version !== 1 || parsed.apiBase !== apiBase) return emptyState(apiBase);
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
      throw new Error("기기 Credential 저장 파일이 올바르지 않다");
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

function identityBase(apiBase: string): string {
  const value = process.env["PAAS_IDENTITY_URL"]?.trim();
  if (value) return value.replace(/\/+$/, "");
  const api = new URL(apiBase);
  if (!api.hostname.startsWith("api.")) {
    throw new Error("PAAS_IDENTITY_URL 이 설정되지 않았고 API 주소에서 Identity 주소를 계산할 수 없다");
  }
  api.hostname = `auth.${api.hostname.slice(4)}`;
  api.pathname = "";
  api.search = "";
  api.hash = "";
  return api.toString().replace(/\/+$/, "");
}

function clientId(): string {
  return process.env["PAAS_DEVICE_CLIENT_ID"]?.trim() || DEFAULT_DEVICE_CLIENT_ID;
}

function deviceName(): string {
  return process.env["PAAS_DEVICE_LABEL"]?.trim() || hostname();
}

/** PaaS access token 의 대상 resource. JWT audience 를 이 값으로 발급받는다. */
function resourceIndicator(): string {
  return process.env["PAAS_RESOURCE"]?.trim() || DEFAULT_RESOURCE;
}

function tokenEndpoint(apiBase: string): string {
  return `${identityBase(apiBase)}/token`;
}

function tokenCredential(body: Record<string, unknown>, args: {
  previousRefreshToken?: string;
  deviceLabel: string;
  privateJwk: JsonWebKey;
}): StoredCredential {
  if (typeof body["access_token"] !== "string") {
    throw new Error("Identity 응답에 access_token이 없다");
  }
  if (String(body["token_type"] ?? "").toLowerCase() !== "dpop") {
    throw new Error("Identity가 DPoP access token을 반환하지 않았다");
  }
  const refreshToken = typeof body["refresh_token"] === "string"
    ? body["refresh_token"]
    : args.previousRefreshToken;
  if (!refreshToken) throw new Error("Identity 응답에 refresh_token이 없다");
  const expiresIn = body["expires_in"];
  if (typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new Error("Identity access token 만료 시간이 올바르지 않다");
  }
  return {
    accessToken: body["access_token"],
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    deviceLabel: args.deviceLabel,
    privateJwk: args.privateJwk,
  };
}

async function refreshCredential(apiBase: string): Promise<StoredCredential | null> {
  // 여러 프로세스(Claude Code 와 Codex)가 같은 device.json 을 동시에 갱신하면
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
  const endpoint = tokenEndpoint(apiBase);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      dpop: createDpopProof({
        privateJwk: credential.privateJwk,
        method: "POST",
        url: endpoint,
      }),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId(),
      refresh_token: credential.refreshToken,
      resource: resourceIndicator(),
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    if (body["error"] === "invalid_grant") {
      state.credential = null;
      await writeState(state);
      return null;
    }
    throw new Error(`Identity가 기기 Credential을 갱신하지 못했다: ${String(body["error"] ?? response.status)}`);
  }
  const refreshed = tokenCredential(body, {
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
    dpop: createDpopProof({
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
  const response = await fetch(`${identityBase(apiBase)}/device/auth`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId(),
      scope: "openid profile paas:access offline_access",
      device_name: deviceName(),
      resource: resourceIndicator(),
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error("Identity가 기기 로그인을 시작하지 못했다");
  const deviceCode = typeof body["device_code"] === "string" ? body["device_code"] : null;
  const userCode = typeof body["user_code"] === "string" ? body["user_code"] : null;
  const verificationUri = typeof body["verification_uri"] === "string" ? body["verification_uri"] : null;
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : null;
  const interval = typeof body["interval"] === "number" ? Math.max(1, Math.ceil(body["interval"])) : 5;
  if (!deviceCode || !userCode || !verificationUri || !expiresIn || expiresIn <= 0) {
    throw new Error("Identity Device Flow 응답 형식이 올바르지 않다");
  }
  const pending: PendingAuthorization = {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof body["verification_uri_complete"] === "string"
        ? body["verification_uri_complete"]
        : null,
    intervalSeconds: interval,
    nextPollAt: Date.now() + interval * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
    privateJwk,
  };
  const state = await readState(apiBase);
  state.pending = pending;
  await writeState(state);
  return {
    userCode,
    verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

export async function completeDeviceLogin(apiBase: string): Promise<
  | { status: "approved"; deviceLabel: string }
  | { status: "pending" | "denied" | "expired" | "polling_limit" }
> {
  const state = await readState(apiBase);
  const pending = state.pending;
  if (pending === null) throw new Error("먼저 start_paas_login 을 실행해야 한다");
  let intervalSeconds = pending.intervalSeconds;
  let nextPollAt = pending.nextPollAt;
  for (let poll = 0; poll < 12; poll += 1) {
    if (Date.now() >= pending.expiresAt) {
      state.pending = null;
      await writeState(state);
      return { status: "expired" };
    }
    const waitMilliseconds = Math.max(0, nextPollAt - Date.now());
    if (waitMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
    }
    const endpoint = tokenEndpoint(apiBase);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        dpop: createDpopProof({
          privateJwk: pending.privateJwk,
          method: "POST",
          url: endpoint,
        }),
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: clientId(),
        resource: resourceIndicator(),
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    if (response.ok) {
      const deviceLabel = deviceName();
      state.credential = tokenCredential(body, {
        deviceLabel,
        privateJwk: pending.privateJwk,
      });
      state.pending = null;
      await writeState(state);
      return { status: "approved", deviceLabel };
    }
    const error = body["error"];
    if (error === "authorization_pending") {
      nextPollAt = Date.now() + intervalSeconds * 1000;
      continue;
    }
    if (error === "slow_down") {
      intervalSeconds += 5;
      nextPollAt = Date.now() + intervalSeconds * 1000;
      continue;
    }
    if (error === "access_denied" || error === "expired_token") {
      state.pending = null;
      await writeState(state);
      return { status: error === "access_denied" ? "denied" : "expired" };
    }
    throw new Error(`Identity Device Flow가 실패했다: ${String(error)}`);
  }
  return { status: "polling_limit" };
}
