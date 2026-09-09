import { mkdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";

// 같은 파일을 여러 프로세스(Claude Code 와 Codex 가 각자 MCP 서버를 띄우는 경우)가
// 동시에 갱신할 때 마지막 쓰기가 앞선 갱신을 덮어써 데이터가 유실되는 것을 막는다.
// mkdir 의 원자성을 잠금으로 쓴다.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_RETRIES = 500;

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
  throw new Error("파일 잠금을 얻지 못했다. 잠시 후 다시 시도한다");
}

/** file 옆에 `<file>.lock` 디렉터리를 잠금으로 만들어 work 를 직렬화한다. */
export async function withFileLock<T>(
  file: string,
  work: () => Promise<T>,
): Promise<T> {
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
