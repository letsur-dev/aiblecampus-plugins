/**
 * 저장한 파일을 대화에 링크로 보이게 한다. `generate_image`, `generate_video`, `video_status` 결과가 쓴다.
 * 경로만 적으면 클로드가 코드 글씨(백틱)로 쓰고 긴 이름이 잘리므로 `[파일 이름](file:///절대경로)` 마크다운 링크를 준다.
 * 주소는 공백, 한글, 괄호를 퍼센트 인코딩하고, 링크 글자에서는 마크다운 문법 글자만 막는다.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 파일 주소. 마크다운 링크 괄호를 깨는 `(`, `)`도 인코딩한다 */
function fileUrl(file: string): string {
  return pathToFileURL(path.resolve(file)).href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** `[파일 이름](file:///...)`. 이름은 자르지 않는다 */
export function fileLink(file: string): string {
  const name = path.basename(file).replace(/([\\[\]])/g, "\\$1");
  return `[${name}](${fileUrl(file)})`;
}

/** 결과 `안내`에 붙이는 문장. 링크를 바꾸지 말고 그대로 보이게 한다 */
export const LINK_NOTE = "답변에는 결과의 파일_링크(마크다운 링크)를 글자 하나 바꾸지 않고 그대로 붙여 보여 준다. 코드 글씨(백틱)로 감싸거나 이름을 줄이거나(…) 경로를 따로 풀어 쓰지 않는다.";
