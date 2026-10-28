import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
const State = z.object({ api: z.string(), deployment: z.string(), workspace: z.string().nullable(), commit: z.string().regex(/^[a-f0-9]{40}$/) });
/** 폴더가 연결된 앱과 공간, 기준 커밋(.apps-source.json) */
export type SourceState = z.infer<typeof State>;
const Snapshot = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })).max(5000) });
/** 폴더 기록(.apps-source.json). 없으면 undefined, 형식이 틀리면 오류다 */
export async function readSourceState(root: string): Promise<SourceState | undefined> {
  let text: string;
  try { text = await readFile(path.join(root, ".apps-source.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return State.parse(JSON.parse(text));
}
/**
 * 폴더에 남은 기준 커밋(.apps-source.json). 다른 앱이나 공간에 연결된 폴더면 사용자에게 고르게 하는 오류다.
 * newApp이면(사용자가 다른 이름의 새 앱을 골랐다) 같은 API와 공간에서 다른 앱 이름일 때 기준 없이 새 앱으로 배포한다. 배포 뒤 연결은 새 앱으로 바뀐다
 */
export async function readSourceBase(root: string, api: string, deployment: string, workspace?: string, newApp = false): Promise<string | undefined> {
  const state = await readSourceState(root);
  if (state === undefined) return undefined;
  if (state.api === api && state.deployment === deployment && state.workspace === (workspace ?? null)) return state.commit;
  if (newApp && state.api === api && state.workspace === (workspace ?? null)) return undefined;
  if (state.api === api && state.workspace === (workspace ?? null)) {
    throw new Error(
      `이 폴더는 이미 앱 '${state.deployment}'로 배포돼 있습니다. 배포하지 않았습니다. 사용자에게 고르게 하세요: ` +
        `1) 기존 앱을 새 버전으로 갱신(주소 유지): name을 '${state.deployment}'로 다시 배포합니다. ` +
        `2) 다른 이름의 새 앱으로 배포: 사용자가 고른 경우에만 새 name과 newApp: true로 다시 배포합니다. 폴더를 복사해 우회하지 않습니다.`,
    );
  }
  throw new Error(`이 폴더는 다른 공간이나 다른 Apps 주소의 앱 '${state.deployment}'로 배포돼 있습니다. 배포하지 않았습니다. 개인 산출물 배포와 조 산출물 배포 중 어디에 올릴지 사용자에게 확인하세요.`);
}
export async function saveSourceBase(root: string, api: string, deployment: string, workspace: string | undefined, commit: string): Promise<void> {
  const state = State.parse({ api, deployment, workspace: workspace ?? null, commit });
  await writeFile(path.join(root, ".apps-source.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
/** 새 폴더에만 저장한다. 기존 작업 파일을 덮어쓰지 않는다. */
export async function checkoutSnapshot(root: string, raw: unknown, api: string, deployment: string, workspace?: string): Promise<string> {
  const snapshot = Snapshot.parse(raw);
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of snapshot.files) {
    if (!file.path || file.path.includes("\\") || file.path.includes(":") || path.posix.isAbsolute(file.path) || file.path.includes("\0") ||
      file.path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".apps-source.json") || seen.has(file.path)) throw new Error("소스 파일 경로가 올바르지 않다");
    seen.add(file.path);
    bytes += Buffer.byteLength(file.content, "base64");
    if (bytes > 64 * 1024 * 1024) throw new Error("소스 크기 상한을 초과했다");
  }
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const file of snapshot.files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.content, "base64"), { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
  }
  await saveSourceBase(root, api, deployment, workspace, snapshot.commit);
  return snapshot.commit;
}
