import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

type PendingAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalSeconds: number;
  nextPollAt: number;
  expiresAt: number;
};

type LocalState = {
  version: 1;
  apiBase: string;
  credential: { accessToken: string; expiresAt: number | null; deviceLabel: string } | null;
  pending: PendingAuthorization | null;
};

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
  return parsed;
}

function readStateSync(apiBase: string): LocalState {
  try {
    return parseState(readFileSync(stateFile(), "utf8"), apiBase);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("기기 Credential 저장 파일이 올바르지 않다");
    }
    return emptyState(apiBase);
  }
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

function identityBase(): string {
  const value = process.env["PAAS_IDENTITY_URL"]?.trim();
  if (!value) throw new Error("PAAS_IDENTITY_URL 이 설정되지 않았다");
  return value.replace(/\/+$/, "");
}

function clientId(): string {
  return process.env["PAAS_DEVICE_CLIENT_ID"]?.trim() || "aiblecampus-paas-device";
}

function deviceName(): string {
  return process.env["PAAS_DEVICE_LABEL"]?.trim() || hostname();
}

/** PaaS access token 의 대상 resource. JWT audience 를 이 값으로 발급받는다. */
function resourceIndicator(): string {
  return process.env["PAAS_RESOURCE"]?.trim() || "urn:aiblecampus:paas";
}

export function loadDeviceCredential(apiBase: string): string | null {
  const credential = readStateSync(apiBase).credential;
  if (credential === null) return null;
  if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) return null;
  return credential.accessToken;
}

export async function startDeviceLogin(apiBase: string): Promise<{
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
}> {
  const response = await fetch(`${identityBase()}/device/auth`, {
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
    const response = await fetch(`${identityBase()}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: clientId(),
        resource: resourceIndicator(),
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    if (response.ok) {
      if (typeof body["access_token"] !== "string") throw new Error("Identity 응답에 access_token이 없다");
      const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : null;
      const deviceLabel = deviceName();
      state.credential = {
        accessToken: body["access_token"],
        expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
        deviceLabel,
      };
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
