import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isSensitiveEnvName } from "./pack.ts";

const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]*$/;

export type LocalEnvSelection = {
  file: string;
  envKeys: string[];
  secretKeys: string[];
};

export type SelectedLocalConfiguration = {
  env: Record<string, string>;
  secrets: Record<string, string>;
};

function parseDoubleQuoted(value: string, file: string, line: number): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new Error(`${file} ${line}번째 줄의 큰따옴표 값을 읽지 못했다`);
  }
}

/** 값은 호출자에게 선택된 키만 돌려주며 오류에도 원문을 넣지 않는다. */
export function parseLocalEnv(
  source: string,
  file = ".env.local",
): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, original] of lines.entries()) {
    const trimmed = original.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(withoutExport);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(`${file} ${index + 1}번째 줄의 KEY=value 형식을 확인한다`);
    }
    const key = match[1];
    const raw = match[2].trim();
    let value: string;
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"')) {
        throw new Error(`${file} ${index + 1}번째 줄의 큰따옴표를 닫는다`);
      }
      value = parseDoubleQuoted(raw, file, index + 1);
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'")) {
        throw new Error(`${file} ${index + 1}번째 줄의 작은따옴표를 닫는다`);
      }
      value = raw.slice(1, -1);
    } else {
      value = raw.replace(/\s+#.*$/, "").trimEnd();
    }
    values[key] = value;
  }
  return values;
}

function uniqueKeys(keys: string[], kind: string): string[] {
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (!ENVIRONMENT_KEY.test(key)) {
      throw new Error(`${kind} 키 형식이 올바르지 않다: ${key}`);
    }
  }
  return unique;
}

/**
 * 사용자가 승인해 도구 인자에 이름을 넣은 키만 로컬 env 파일에서 읽는다.
 * 파일의 다른 값은 조회하거나 PaaS로 전달하지 않는다.
 */
export async function loadSelectedLocalEnv(
  projectRoot: string,
  selection: LocalEnvSelection,
): Promise<SelectedLocalConfiguration> {
  if (
    path.basename(selection.file) !== selection.file ||
    !isSensitiveEnvName(selection.file)
  ) {
    throw new Error("localEnv.file은 프로젝트 루트의 실제 .env 계열 파일이어야 한다");
  }
  const root = await realpath(projectRoot);
  const selectedPath = path.join(root, selection.file);
  const resolved = await realpath(selectedPath).catch(() => null);
  if (resolved === null || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`로컬 env 파일을 찾지 못했다: ${selection.file}`);
  }

  const envKeys = uniqueKeys(selection.envKeys, "일반 설정");
  const secretKeys = uniqueKeys(selection.secretKeys, "비밀값");
  if (envKeys.length === 0 && secretKeys.length === 0) {
    throw new Error("localEnv에 사용할 일반 설정 또는 비밀값 키를 하나 이상 지정한다");
  }
  const overlap = envKeys.find((key) => secretKeys.includes(key));
  if (overlap !== undefined) {
    throw new Error(`같은 키를 일반 설정과 비밀값으로 함께 사용할 수 없다: ${overlap}`);
  }

  const parsed = parseLocalEnv(await readFile(resolved, "utf8"), selection.file);
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const key of envKeys) {
    if (parsed[key] === undefined) {
      throw new Error(`${selection.file}에 일반 설정 키 ${key}가 없다`);
    }
    env[key] = parsed[key];
  }
  for (const key of secretKeys) {
    const value = parsed[key];
    if (value === undefined || value === "") {
      throw new Error(`${selection.file}에 비밀값 키 ${key}가 없거나 비어 있다`);
    }
    secrets[key] = value;
  }
  return { env, secrets };
}
