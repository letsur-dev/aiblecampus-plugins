/**
 * 앱 표시 이름과 버전 설명(0.32.0). 한 줄로 다듬어 값이 있을 때만 보낸다. 멱등 지문에는 넣지 않는다
 * (응답이 끊긴 뒤 에이전트가 설명을 달리 적어 다시 보내도 같은 배포로 복구해야 한다)
 */
export function appMeta(input: { displayName?: string | undefined; renameApp?: boolean | undefined; changeSummary?: string | undefined }): {
  displayName?: string;
  renameApp?: boolean;
  changeSummary?: string;
} {
  const oneLine = (value: string | undefined) => value?.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim() || undefined;
  const displayName = oneLine(input.displayName);
  const changeSummary = oneLine(input.changeSummary);
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(displayName !== undefined && input.renameApp === true ? { renameApp: true } : {}),
    ...(changeSummary === undefined ? {} : { changeSummary }),
  };
}

/**
 * 갤러리 설명(0.34.0). 서버의 배포 요청 계약(`@aiblecampus/contracts/gallery` galleryWriteupSchema)의 섹션 칸과 한도를 그대로 옮겼다.
 * 칸 이름과 안내는 0.34.0 당시의 문구이고, 허브는 받은 칸을 정해진 소제목의 본문으로 바꾼다(2026-10-08)
 * (공개 저장소에서 따로 빌드하므로 허브 패키지를 가져오지 않는다. 칸과 한도가 같은지는 단위 시험이 본다)
 */
export const GALLERY_SECTIONS = [
  { key: "problem", label: "문제", hint: "어떤 일의 어떤 불편을 풀려고 했나요?" },
  { key: "solution", label: "해결 방법", hint: "무엇을 만들었고 어떻게 동작하나요?" },
  { key: "usage", label: "사용 방법", hint: "누가 언제 어떻게 쓰나요?" },
  { key: "impact", label: "효과", hint: "시간, 품질, 비용이 어떻게 달라지나요?" },
  { key: "learned", label: "배운 점", hint: "만들면서 배운 점과 다음에 해 볼 일" },
] as const;
export type GallerySectionKey = (typeof GALLERY_SECTIONS)[number]["key"];
export const GALLERY_SUMMARY_MAX = 120;
export const GALLERY_SECTION_MAX = 3000;

export type GalleryInput = { summary?: string | undefined; sections?: Partial<Record<GallerySectionKey, string | undefined>> | undefined };

/**
 * 보낼 갤러리 설명. 요약은 한 줄로, 섹션은 줄 끝을 LF로 맞추고 제어 문자를 지운다. 빈 칸은 빼고, 남은 것이 없으면 보내지 않는다.
 * 길이 한도는 도구 입력 스키마가 먼저 막는다. 멱등 지문에는 넣지 않는다
 */
export function galleryWriteup(input: GalleryInput | undefined): { summary?: string; sections: Partial<Record<GallerySectionKey, string>> } | undefined {
  if (input === undefined) return undefined;
  const summary = input.summary?.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, GALLERY_SUMMARY_MAX) || undefined;
  const sections: Partial<Record<GallerySectionKey, string>> = {};
  for (const { key } of GALLERY_SECTIONS) {
    const text = input.sections?.[key]
      ?.replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- 줄바꿈과 탭 말고 제어 문자를 지운다
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
      .slice(0, GALLERY_SECTION_MAX);
    if (text) sections[key] = text;
  }
  if (summary === undefined && Object.keys(sections).length === 0) return undefined;
  return { ...(summary === undefined ? {} : { summary }), sections };
}
