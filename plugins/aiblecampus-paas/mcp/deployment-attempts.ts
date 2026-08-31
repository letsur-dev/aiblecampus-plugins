import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type DeploymentAttempt = {
  key: string;
  expiresAt: number;
};

type DeploymentAttemptState = {
  version: 1;
  attempts: Record<string, DeploymentAttempt>;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_RETRIES = 200;

function defaultAttemptFile(): string {
  const configured = process.env["PAAS_DEPLOYMENT_ATTEMPT_FILE"]?.trim();
  if (configured) return path.resolve(configured);
  const configRoot =
    process.env["XDG_CONFIG_HOME"]?.trim() || path.join(homedir(), ".config");
  return path.join(
    configRoot,
    "aiblecampus-paas",
    "deployment-attempts.json",
  );
}

function emptyState(): DeploymentAttemptState {
  return { version: 1, attempts: {} };
}

function parseState(raw: string): DeploymentAttemptState {
  const parsed = JSON.parse(raw) as Partial<DeploymentAttemptState>;
  if (
    parsed.version !== 1 ||
    parsed.attempts === null ||
    typeof parsed.attempts !== "object" ||
    Array.isArray(parsed.attempts)
  ) {
    throw new Error("배포 요청 복구 파일 형식이 올바르지 않다");
  }
  const attempts: Record<string, DeploymentAttempt> = {};
  for (const [fingerprint, attempt] of Object.entries(parsed.attempts)) {
    if (
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      attempt === null ||
      typeof attempt !== "object" ||
      typeof attempt.key !== "string" ||
      attempt.key.length === 0 ||
      typeof attempt.expiresAt !== "number" ||
      !Number.isFinite(attempt.expiresAt)
    ) {
      throw new Error("배포 요청 복구 파일 형식이 올바르지 않다");
    }
    attempts[fingerprint] = {
      key: attempt.key,
      expiresAt: attempt.expiresAt,
    };
  }
  return { version: 1, attempts };
}

async function readState(file: string): Promise<DeploymentAttemptState> {
  try {
    return parseState(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        error.message === "배포 요청 복구 파일 형식이 올바르지 않다")
    ) {
      throw new Error(
        `배포 요청 복구 파일 형식이 올바르지 않다: ${file}. 파일을 별도 위치로 옮긴 뒤 deployment_status로 기존 배포를 먼저 확인한다`,
      );
    }
    throw error;
  }
}

async function writeState(
  file: string,
  state: DeploymentAttemptState,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
}

async function acquireLock(lockDirectory: string): Promise<void> {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const current = await stat(lockDirectory);
        if (Date.now() - current.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lockDirectory);
          continue;
        }
      } catch (inspectionError) {
        const code = (inspectionError as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code !== "ENOTEMPTY") throw inspectionError;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("배포 요청 복구 파일을 잠그지 못했다. 잠시 후 다시 시도한다");
}

async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockDirectory = `${file}.lock`;
  await acquireLock(lockDirectory);
  try {
    return await work();
  } finally {
    try {
      await rmdir(lockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function deploymentAttempt(
  fingerprint: string,
  forceNewRevision: boolean,
  options: {
    file?: string;
    now?: number;
    ttlMs?: number;
  } = {},
): Promise<{ key: string; recovered: boolean }> {
  const file = options.file ?? defaultAttemptFile();
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  return withFileLock(file, async () => {
    const state = await readState(file);
    for (const [candidate, attempt] of Object.entries(state.attempts)) {
      if (attempt.expiresAt <= now) delete state.attempts[candidate];
    }
    const existing = state.attempts[fingerprint];
    if (!forceNewRevision && existing !== undefined) {
      await writeState(file, state);
      return { key: existing.key, recovered: true };
    }
    const attempt = {
      key: randomUUID(),
      expiresAt: now + ttlMs,
    };
    state.attempts[fingerprint] = attempt;
    await writeState(file, state);
    return { key: attempt.key, recovered: false };
  });
}
