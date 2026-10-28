/**
 * 클로드에서 바로 이미지 생성(0.42.0, 2026-10-20). MCP 도구 `generate_image`가 쓴다.
 *
 * - platform `POST /v1/images/generations`가 앱용 AI 공용 키로 게이트웨이를 부른다. 키는 플러그인에 오지 않는다
 * - 크기와 길이 한도는 서버 계약(`@aiblecampus/contracts/platform-api/images`)을 옮겼다. 공개 저장소에서 따로 빌드하므로
 *   허브 패키지를 가져오지 않고, 값이 같은지는 단위 시험이 본다
 * - 받은 이미지는 저장 폴더에 새 파일로 쓴다. 같은 이름이 있으면 번호를 붙이고 덮어쓰지 않는다
 */
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const IMAGE_PROMPT_MAX_LENGTH = 4000;
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

/** 서버 성공 응답 중 쓰는 칸 */
export const GeneratedImage = z.looseObject({
  model: z.string().min(1),
  size: z.enum(IMAGE_SIZES),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  imageBase64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  remainingToday: z.number().int().min(0),
});
export type GeneratedImage = z.infer<typeof GeneratedImage>;

const EXTENSIONS: Record<GeneratedImage["mimeType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** 저장 폴더. 지정하지 않으면 MCP를 실행한 폴더(작업 폴더) 아래 images/다 */
export function imageDirectory(directory: string | undefined, cwd: string = process.cwd()): string {
  return directory === undefined ? path.join(cwd, "images") : path.resolve(cwd, directory);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 파일 이름 앞부분: 이 컴퓨터 시각의 YYYYMMDD-HHMMSS와 프롬프트 앞 낱말(글자와 숫자만) */
export function imageFileStem(prompt: string, now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = [...prompt.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+/, "")]
    .slice(0, 40)
    .join("")
    .replace(/-+$/, "");
  return `${stamp}-${slug || "image"}`;
}

/** 이미지를 새 파일로 저장하고 절대 경로를 돌려준다. 있는 파일은 덮어쓰지 않는다 */
export async function saveImage(directory: string, prompt: string, image: GeneratedImage, now: Date = new Date()): Promise<string> {
  const bytes = Buffer.from(image.imageBase64, "base64");
  if (bytes.length === 0) throw new Error("이미지 데이터가 비어 있다");
  await mkdir(directory, { recursive: true });
  const stem = imageFileStem(prompt, now);
  const extension = EXTENSIONS[image.mimeType];
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const file = path.join(directory, `${stem}${attempt === 1 ? "" : `-${attempt}`}.${extension}`);
    const handle = await open(file, "wx", 0o644).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (handle === null) continue;
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return file;
  }
  throw new Error("같은 이름의 파일이 너무 많다");
}

/** 상태별 기본 문구. 서버가 message를 주면 그것을 먼저 쓴다 */
const FALLBACK: Record<number, string> = {
  400: "이미지 요청 내용을 확인하지 못했습니다. 설명을 4000자 안으로 줄이고 크기는 1024x1024, 1536x1024, 1024x1536 중에서 골라 주세요.",
  403: "이미지를 만들 수 있는 교육이 없습니다. 지금 참여 중인 교육이 있으면 교육 담당자에게 문의해 주세요.",
  404: "이미지 만들기를 쓸 수 없습니다. Apps 로그인과 플러그인 버전을 확인해 주세요.",
  409: "이미지를 이미 만들고 있습니다. 끝난 뒤 다시 요청해 주세요.",
  429: "오늘 만들 수 있는 이미지를 모두 만들었습니다. 내일 다시 이용해 주세요.",
  502: "이미지를 만들지 못했습니다. 잠시 뒤 다시 요청해 주세요.",
  503: "이미지 만들기가 아직 준비되지 않았습니다. 교육 담당자에게 문의해 주세요.",
};

/** 다음 행동. 사용자에게 전할 문구가 아니라 클로드가 따를 안내다 */
const NEXT: Record<number, string> = {
  409: "자동으로 다시 시도하지 않는다. 앞 요청이 끝난 뒤 사용자가 원하면 다시 부른다.",
  429: "다시 시도하지 않는다. 다른 이미지 서비스나 API 키를 찾아 우회하지 않는다.",
  502: "자동으로 다시 시도하지 않는다. 사용자가 원하면 한 번 다시 부른다.",
  503: "다시 시도하지 않는다. API 키를 묻거나 다른 이미지 서비스로 우회하지 않는다.",
  403: "다시 시도하지 않는다. API 키를 묻거나 다른 이미지 서비스로 우회하지 않는다.",
};

/** 실패 응답을 사용자에게 전할 문구로 바꾼다. 서버 message를 그대로 전하고, 없으면 상태별 기본 문구를 쓴다 */
export function imageFailureText(status: number, body: unknown): string {
  const parsed = z.object({ message: z.string().trim().min(1).max(1000) }).safeParse(body);
  const message = parsed.success ? parsed.data.message : FALLBACK[status] ?? `이미지를 만들지 못했습니다(상태 ${status}).`;
  const next = NEXT[status];
  return [`사용자에게 그대로 전한다: ${message}`, ...(next === undefined ? [] : [next])].join("\n");
}
