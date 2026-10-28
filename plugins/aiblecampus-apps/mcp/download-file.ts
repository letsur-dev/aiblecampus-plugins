/**
 * 파일 원본 내려받기(0.44.0, 2026-10-27). MCP 도구 `download_my_file`이 쓴다.
 *
 * - platform `GET /v1/personal/educations/:educationId/items/:itemId/download`의 본문 스트림을 사용자 PC 폴더에 새 파일로 쓴다. 통째로 메모리에 올리지 않는다
 * - 저장할 이름은 서버 응답 헤더 `x-hub-file-name`(퍼센트 인코딩)이다. 서버 값도 믿지 않고 마지막 이름 조각만 쓰며 제어 문자와 경로 구분자를 없앤다.
 *   그래서 저장 위치는 항상 고른 폴더 바로 아래 한 파일이다
 * - 있는 파일은 덮어쓰지 않는다(`wx`로 열고 EEXIST면 `이름 (2).확장자`처럼 번호를 붙인다). 한도 초과, 스트림 오류, 받은 크기와 content-length 불일치는
 *   만든 파일을 지우고 실패로 돌려준다
 * - 한도(`PERSONAL_DOWNLOAD_MAX_BYTES`)는 서버 계약을 옮긴 값이다(personal-files.ts). 같은 값인지는 단위 시험이 본다
 */
import { createHash } from "node:crypto";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PERSONAL_DOWNLOAD_MAX_BYTES } from "./personal-files.ts";

/** 저장 폴더를 지정하지 않았을 때 작업 폴더 아래 만드는 폴더 이름 */
export const DOWNLOAD_DEFAULT_DIRECTORY = "aiblecampus-files";
/** 같은 이름이 있을 때 번호를 붙여 보는 상한 */
export const DOWNLOAD_NUMBER_MAX = 999;
/** 파일 이름 바이트 상한(대부분의 파일 시스템 한계) */
const FILE_NAME_MAX_BYTES = 255;

/** 저장 폴더. 지정하지 않으면 MCP를 실행한 폴더(작업 폴더) 아래 aiblecampus-files다 */
export function downloadDirectory(directory: string | undefined, cwd: string = process.cwd()): string {
  return directory === undefined ? path.join(cwd, DOWNLOAD_DEFAULT_DIRECTORY) : path.resolve(cwd, directory);
}

/** 헤더 값을 퍼센트 디코딩한다. 잘못된 인코딩이면 받은 그대로 쓴다 */
function decodeHeaderName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 바이트 상한 안으로 앞부분을 남긴다(문자 중간에서 자르지 않는다) */
function truncateBytes(text: string, limit: number): string {
  let result = "";
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > limit) break;
    result += char;
    used += size;
  }
  return result;
}

/** 서버가 준 이름에서 저장해도 되는 파일 이름 하나를 만든다. 경로 조각, 제어 문자, 상위 폴더 표기는 남기지 않는다 */
export function safeFileName(raw: string | null | undefined): string {
  const decoded = decodeHeaderName(raw ?? "").normalize("NFC");
  // 마지막 이름 조각만 쓴다. 경로 구분자는 / 와 \ 모두 본다
  const last = decoded.split(/[\\/]+/).filter((part) => part !== "").pop() ?? "";
  let name = last
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    // 끝의 점과 공백은 Windows가 지운다. 점만 있는 이름(.과 ..)은 이 단계에서 빈 이름이 된다. 앞의 점(.gitignore)은 그대로 둔다
    .replace(/[\s.]+$/, "");
  if (name === "") return "download";
  // Windows 장치 이름은 파일로 열 수 없다
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  return fitName(name, "");
}

/** 이름 끝에 suffix를 붙여도 255바이트를 넘지 않게 확장자는 두고 앞 이름을 줄인다 */
function fitName(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && byteLength(name) - byteLength(name.slice(0, dot)) <= 20;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  return `${truncateBytes(stem, FILE_NAME_MAX_BYTES - byteLength(extension) - byteLength(suffix))}${suffix}${extension}`;
}

/** 번호를 붙인 이름 `이름 (2).확장자`. 1번은 이름 그대로다 */
export function numberedFileName(name: string, number: number): string {
  return number <= 1 ? name : fitName(name, ` (${number})`);
}

export class DownloadError extends Error {}

/** 만든 파일을 닫고 지운다. 이미 없어도 오류로 보지 않는다 */
async function discard(handle: FileHandle, file: string): Promise<void> {
  await handle.close().catch(() => undefined);
  await unlink(file).catch(() => undefined);
}

/** 선택한 폴더 바로 아래에 새 파일을 연다. 같은 이름이 있으면 번호를 붙인다 */
async function openNewFile(directory: string, name: string): Promise<{ handle: FileHandle; file: string; name: string; number: number }> {
  for (let number = 1; number <= DOWNLOAD_NUMBER_MAX; number += 1) {
    const candidate = numberedFileName(name, number);
    const file = path.join(directory, candidate);
    // 이름에는 구분자가 없으므로 항상 폴더 바로 아래다. 한 번 더 확인한다
    if (path.dirname(file) !== directory || path.basename(file) !== candidate) throw new DownloadError("저장 경로가 폴더 밖을 가리켜 저장하지 않았다");
    try {
      return { handle: await open(file, "wx", 0o644), file, name: candidate, number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new DownloadError(`같은 이름의 파일이 너무 많다(${DOWNLOAD_NUMBER_MAX}개). 다른 폴더를 고른다`);
}

export type SavedDownload = { 경로: string; 이름: string; 바이트: number; sha256: string; 원본_이름: string; 번호_붙임: boolean };

/**
 * 응답 본문을 폴더에 새 파일로 저장한다. 크기와 sha256은 쓰면서 센다.
 * `maxBytes`는 시험용으로만 낮춘다
 */
export async function saveDownload(response: Response, directory: string, maxBytes: number = PERSONAL_DOWNLOAD_MAX_BYTES): Promise<SavedDownload> {
  const header = response.headers.get("x-hub-file-name");
  // 서버가 이름을 주지 않았으면 서버 응답이 아닌 것(앞단의 오류 페이지 등)일 수 있어 저장하지 않는다
  if (header === null || header.trim() === "") throw new DownloadError("서버 응답에 파일 이름(x-hub-file-name)이 없어 저장하지 않았다. 플러그인과 서버가 같은 버전인지 확인한다");
  if (response.body === null) throw new DownloadError("서버 응답에 파일 내용이 없어 저장하지 않았다");
  const declaredText = response.headers.get("content-length");
  const declared = declaredText !== null && /^\d+$/.test(declaredText) ? Number(declaredText) : null;
  if (declared !== null && declared > maxBytes) throw new DownloadError(`파일이 내려받기 한도(${maxBytes}바이트)를 넘어 저장하지 않았다`);
  // 압축 전송이면 content-length는 압축 크기라 받은 크기와 비교하지 않는다
  const encoding = response.headers.get("content-encoding");
  const comparable = declared !== null && (encoding === null || encoding === "" || encoding.toLowerCase() === "identity");

  const target = path.resolve(directory);
  await mkdir(target, { recursive: true });
  const original = decodeHeaderName(header).replace(/[\p{Cc}\p{Cf}]/gu, "");
  const { handle, file, name, number } = await openNewFile(target, safeFileName(header));
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new DownloadError(`파일이 내려받기 한도(${maxBytes}바이트)를 넘어 저장을 멈추고 지웠다`);
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        offset += (await handle.write(value, offset, value.byteLength - offset)).bytesWritten;
      }
    }
    if (comparable && bytes !== declared) throw new DownloadError(`받은 크기(${bytes}바이트)가 서버가 알린 크기(${declared}바이트)와 달라 저장을 취소하고 지웠다`);
    await handle.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await discard(handle, file);
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(`내려받는 중 끊겨 저장을 취소하고 지웠다: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { 경로: file, 이름: name, 바이트: bytes, sha256: hash.digest("hex"), 원본_이름: original.slice(0, FILE_NAME_MAX_BYTES), 번호_붙임: number > 1 };
}
