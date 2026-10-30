import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
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

/**
 * 참가자 앱의 프레임워크(Next의 @next/env, Vite loadEnv)와 같은 dotenv 해석으로 읽는다: 따옴표 세 종류, 여러 줄 큰따옴표 값,
 * 큰따옴표 안 `\n`, 줄 끝 주석, `export`, 형식이 아닌 줄은 건너뛴다. `$VAR` 펼치기(dotenv-expand)는 하지 않는다.
 * 값은 호출자에게 선택된 키만 돌려주며 오류에도 원문을 넣지 않는다.
 */
export function parseLocalEnv(source: string): Record<string, string> {
  // dotenv는 BOM을 지우지 않아 첫 키를 놓친다(편집기가 붙인 BOM)
  return parse(source.replace(/^\uFEFF/, ""));
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
 * 파일의 다른 값은 조회하거나 Apps로 전달하지 않는다.
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

  const parsed = parseLocalEnv(await readFile(resolved, "utf8"));
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
