/**
 * 도구 `generate_video`(접수)와 `video_status`(완성 기다리기, 완료 시 내려받기). 서버가 앱용 AI 공용 키로 게이트웨이를 부르며 키는 플러그인에 오지 않는다.
 * 영상은 몇 분 걸리므로 generate_video는 기다리지 않고, video_status는 서버가 최대 VIDEO_WAIT_MAX_SECONDS까지 기다려 주며 아직이면 sleep 없이 같은 도구를 바로 다시 부른다.
 * 완료되면 서버가 준 서명 주소로 인증 헤더 없이 받아 `videos/`에 새 파일로 저장하고(번호를 붙이며 덮어쓰지 않는다), 주소가 만료돼 받지 못하면 video_status를 다시 불러 새 주소를 받는다. 한도는 서버 계약(`@aiblecampus/contracts/platform-api/videos`)을 옮긴 값이다.
 */
import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export const VIDEO_PROMPT_MAX_LENGTH = 4000;
export const VIDEO_DURATION_MIN = 4;
export const VIDEO_DURATION_MAX = 15;
export const VIDEO_RESOLUTIONS = ["480p", "720p"] as const;
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
/** 접수한 작업이 이 시간(분) 안에 끝나지 않으면 서버가 실패(timeout)로 확정한다 */
export const VIDEO_JOB_TIMEOUT_MINUTES = 20;
/** video_status가 서버에서 기다리는 최대 초. 데스크톱의 MCP 도구 호출이 약 60초에 끊긴다는 보고가 있어 내려받을 시간을 남긴다. 서버 계약과 같다 */
export const VIDEO_WAIT_MAX_SECONDS = 40;
/** 받는 파일 크기 상한(바이트). 수업용 짧은 영상에는 충분하고, 잘못된 주소가 큰 파일을 보내도 디스크를 채우지 않는다 */
const VIDEO_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

const Iso = z.iso.datetime({ offset: true });

/** 접수 성공 응답(202) 중 쓰는 칸 */
export const AcceptedVideo = z.looseObject({
  id: z.uuid(),
  model: z.string().min(1),
  status: z.enum(["queued", "running"]),
  durationSeconds: z.number().int(),
  resolution: z.enum(VIDEO_RESOLUTIONS),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
});
export type AcceptedVideo = z.infer<typeof AcceptedVideo>;

/** 상태 조회 성공 응답 중 쓰는 칸 */
export const VideoStatusResult = z.looseObject({
  id: z.uuid(),
  model: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  createdAt: Iso,
  durationSeconds: z.number().int(),
  resolution: z.enum(VIDEO_RESOLUTIONS),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
  elapsedSeconds: z.number().int().min(0),
  failure: z.string().nullable(),
  failureCode: z.string().nullable(),
  download: z
    .looseObject({ url: z.url(), expiresAt: Iso.nullable(), contentType: z.string().min(1), sizeBytes: z.number().int().min(0).nullable() })
    .nullable(),
});
export type VideoStatusResult = z.infer<typeof VideoStatusResult>;

/** 저장 폴더. 지정하지 않으면 MCP를 실행한 폴더(작업 폴더) 아래 videos/다 */
export function videoDirectory(directory: string | undefined, cwd: string = process.cwd()): string {
  return directory === undefined ? path.join(cwd, "videos") : path.resolve(cwd, directory);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 파일 이름 앞부분: 접수 시각(이 컴퓨터 시각)의 YYYYMMDD-HHMMSS와 작업 ID 앞 8자리. 같은 작업은 늘 같은 이름이라 이미 받았는지 알 수 있다 */
export function videoFileStem(id: string, createdAt: string): string {
  const time = new Date(createdAt);
  const stamp = `${time.getFullYear()}${pad(time.getMonth() + 1)}${pad(time.getDate())}-${pad(time.getHours())}${pad(time.getMinutes())}${pad(time.getSeconds())}`;
  return `${stamp}-video-${id.replace(/[^0-9a-f]/gi, "").slice(0, 8)}`;
}

const EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

export function videoExtension(contentType: string): string {
  return EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] ?? "mp4";
}

/** 다운로드를 받지 못했거나 저장하지 못했다. message는 사용자에게 보일 사유다 */
export class VideoDownloadError extends Error {}

export type SavedVideo = { file: string; bytes: number; reused: boolean };

/**
 * 영상을 새 파일로 저장한다. 같은 이름이 있으면 번호를 붙이고 덮어쓰지 않는다. 같은 이름의 파일 크기가 서버가 알려 준 크기와 같으면
 * 이미 받은 작업으로 보고 다시 받지 않는다(크기를 모르면 확인할 수 없어 새 번호로 받는다). 내려받다 실패하면 반쯤 쓴 파일을 지운다
 */
export async function saveVideo(
  directory: string,
  stem: string,
  extension: string,
  expectedBytes: number | null,
  openBody: () => Promise<ReadableStream<Uint8Array>>,
): Promise<SavedVideo> {
  if (expectedBytes !== null && expectedBytes > VIDEO_DOWNLOAD_MAX_BYTES) throw new VideoDownloadError("영상 파일이 너무 커서 받지 않았다");
  await mkdir(directory, { recursive: true });
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const file = path.join(directory, `${stem}${attempt === 1 ? "" : `-${attempt}`}.${extension}`);
    const existing = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null) {
      if (expectedBytes !== null && existing.size === expectedBytes) return { file, bytes: existing.size, reused: true };
      continue;
    }
    const body = await openBody();
    const handle = await open(file, "wx", 0o644).catch(async (error: NodeJS.ErrnoException) => {
      await body.cancel().catch(() => undefined);
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (handle === null) continue;
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(bytes > VIDEO_DOWNLOAD_MAX_BYTES ? new VideoDownloadError("영상 파일이 너무 커서 받다가 멈췄다") : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), counter, handle.createWriteStream());
      if (bytes === 0) throw new VideoDownloadError("영상 데이터가 비어 있다");
      if (expectedBytes !== null && bytes !== expectedBytes) throw new VideoDownloadError(`영상을 끝까지 받지 못했다(${bytes}바이트, 기대 ${expectedBytes}바이트)`);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(file).catch(() => undefined);
      throw error;
    }
    return { file, bytes, reused: false };
  }
  throw new Error("같은 이름의 파일이 너무 많다");
}

/** 지난 시간을 `1분 35초`로 쓴다 */
export function elapsedText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}초` : `${minutes}분 ${seconds % 60}초`;
}
