import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
const State = z.object({ api: z.string(), deployment: z.string(), workspace: z.string().nullable(), commit: z.string().regex(/^[a-f0-9]{40}$/) });
const Snapshot = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })).max(5000) });
export async function readSourceBase(root: string, api: string, deployment: string, workspace?: string): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(path.join(root, ".apps-source.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const state = State.parse(JSON.parse(text));
  if (state.api !== api || state.deployment !== deployment || state.workspace !== (workspace ?? null)) throw new Error("소스 작업 폴더의 앱 또는 작업 공간이 요청과 다르다");
  return state.commit;
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
