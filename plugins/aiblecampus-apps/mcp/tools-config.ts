import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * hub 마켓플레이스가 사람별 압축 파일에 넣은 도구 설정 파일(0.48.0). 플러그인 루트의 `aiblecampus-tools.json`이고 hub 자동 연결 파일(aiblecampus-credential.json)과 같은 자리다.
 *
 * - 파일이 올바르면 `groups`에 든 도구 묶음의 도구와 기반 도구만 클로드에 등록한다. 꺼진 묶음의 도구는 도구 목록에 없다
 * - 파일이 없거나 형식이 틀리면(공개 저장소에서 받아 직접 쓰는 경우) 모든 도구를 등록한다. 서버(platform)가 꺼진 묶음 요청을 403으로 거절한다
 * - `image`, `video` 요약으로 이미지·영상 도구 설명과 서버 지침(instructions)에 이 교육의 모델과 하루 한도를 적는다
 * - 묶음 ID와 파일 이름은 서버 계약(`@aiblecampus/contracts/plugin-tools-config`, `plugin-components`)을 옮겼다. 공개 저장소에서 따로 빌드하므로
 *   허브 패키지를 가져오지 않고, 값이 같은지와 등록한 도구가 계약의 묶음 표와 같은지는 단위 시험이 본다
 */
export const PLUGIN_TOOLS_FILE = "aiblecampus-tools.json";

export const TOOL_GROUP_IDS = ["mcp-image", "mcp-video", "mcp-apps", "mcp-files", "mcp-google", "mcp-gallery"] as const;
export type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];
/** 도구가 속한 묶음. `base`는 묶음이 하나라도 켜지면 함께 있는 기반 도구다 */
export type ToolGroup = ToolGroupId | "base";

const MediaSummary = z.strictObject({
  enabled: z.boolean(),
  model: z.string().min(1).max(200).nullable(),
  dailyLimit: z.number().int().min(0),
});

const ToolsConfigSchema = z.strictObject({
  version: z.literal(1),
  groups: z.array(z.enum(TOOL_GROUP_IDS)).max(TOOL_GROUP_IDS.length),
  image: MediaSummary,
  video: MediaSummary,
});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MediaSummary = z.infer<typeof MediaSummary>;

/** 파일 내용을 읽는다. 형식이 틀리면 null */
export function parseToolsConfig(raw: string): ToolsConfig | null {
  try {
    const parsed = ToolsConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

let cached: ToolsConfig | null | undefined;

/**
 * 플러그인 루트의 도구 설정 파일. 번들(dist/mcp.js)과 소스(mcp/tools-config.ts) 모두 한 단계 위가 플러그인 루트다.
 * 기본 위치는 프로세스마다 한 번 읽는다(새 압축 파일이 설치되면 Claude가 MCP를 다시 띄운다). 없거나 깨졌으면 null이다
 */
export function toolsConfig(file?: string): ToolsConfig | null {
  if (file === undefined && cached !== undefined) return cached;
  let found: ToolsConfig | null;
  try {
    found = parseToolsConfig(readFileSync(file ?? fileURLToPath(new URL(`../${PLUGIN_TOOLS_FILE}`, import.meta.url)), "utf8"));
  } catch {
    found = null;
  }
  if (file === undefined) cached = found;
  return found;
}

/** 이 묶음의 도구를 등록하는가. 설정이 없으면 모두 등록하고, 있으면 켜진 묶음과(묶음이 하나라도 켜졌을 때의) 기반 도구만 등록한다 */
export function toolGroupEnabled(config: ToolsConfig | null, group: ToolGroup): boolean {
  if (config === null) return true;
  return group === "base" ? config.groups.length > 0 : config.groups.includes(group);
}

/** 도구 설명 끝에 붙일 이 교육의 설정 문장. 설정이 없으면 빈 문자열(일반 설명 그대로) */
export function mediaToolNote(summary: MediaSummary | undefined, unit: "장" | "개", label: "이미지" | "영상"): string {
  if (summary === undefined) return "";
  if (!summary.enabled) return ` 이 교육에서는 ${label} 생성을 쓰지 않는다(모델을 정하지 않았거나 하루 한도가 0이다). 부르지 말고 사용자에게 "이 교육에서는 ${label} 생성을 쓰지 않아요"라고 알린다.`;
  return ` 이 교육에서는 사람마다 하루 ${summary.dailyLimit}${unit}까지 만들 수 있고 모델은 ${summary.model ?? "서버가 고른 모델"}이다.`;
}

/**
 * 서버 지침(MCP instructions). Claude가 도구 목록을 보기 전에 이미지·영상을 쓸 수 있는지 안다.
 * 설정이 없으면 null(지침 없음). 사용자에게 전할 말은 따옴표 안의 문장이다
 */
export function toolsInstructions(config: ToolsConfig | null): string | null {
  if (config === null) return null;
  const line = (summary: MediaSummary, label: string, unit: string): string =>
    summary.enabled
      ? `${label} 생성: 쓸 수 있다. 사람마다 하루 ${summary.dailyLimit}${unit}까지, 모델은 ${summary.model ?? "서버가 고른 모델"}이다.`
      : `${label} 생성: 이 교육에서는 쓰지 않는다. 요청받으면 도구를 찾거나 다른 서비스로 우회하지 않고 사용자에게 "이 교육에서는 ${label} 생성을 쓰지 않아요"라고 알린다.`;
  const only = config.image.enabled && !config.video.enabled ? ' 사용자에게는 "이 교육에서는 영상 생성을 쓰지 않아요, 이미지 생성만 가능해요"처럼 알린다.' : "";
  return [line(config.image, "이미지", "장"), line(config.video, "영상", "개")].join("\n") + only;
}
