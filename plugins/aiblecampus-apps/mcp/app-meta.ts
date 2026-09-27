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
