import { appsEnv } from "./config.ts";
import { execFile } from "node:child_process";

type SupportedPlatform = "darwin" | "linux" | "win32";

export function browserCommandFor(
  platform: SupportedPlatform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { command: "xdg-open", args: [url] };
}

/** open_link가 여는 주소의 글자 수 상한 */
export const OPEN_LINK_MAX_LENGTH = 2048;

/**
 * 사용자가 열어 달라고 한 링크를 검사한다. http와 https만, 사용자 이름과 비밀번호가 든 주소와 공백, 제어 문자가 든 주소는 거절한다.
 * 통과하면 브라우저에 넘길 정규화한 주소를, 아니면 거절 이유를 돌려준다
 */
export function parseOpenableUrl(value: string): { ok: true; href: string } | { ok: false; reason: string } {
  if (value.length === 0 || value.length > OPEN_LINK_MAX_LENGTH) return { ok: false, reason: `주소는 1자 이상 ${OPEN_LINK_MAX_LENGTH}자 이하여야 한다` };
  if (/[\s\p{Cc}\p{Cf}]/u.test(value)) return { ok: false, reason: "주소에 공백이나 제어 문자가 있다" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "올바른 주소가 아니다" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "http 또는 https 주소만 열 수 있다" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "사용자 이름이나 비밀번호가 든 주소는 열지 않는다" };
  if (url.hostname === "") return { ok: false, reason: "주소에 호스트가 없다" };
  if (url.href.length > OPEN_LINK_MAX_LENGTH) return { ok: false, reason: `정규화한 주소가 ${OPEN_LINK_MAX_LENGTH}자를 넘는다` };
  return { ok: true, href: url.href };
}

/** Device Flow 승인 주소와 open_link의 링크(parseOpenableUrl을 통과한 주소)를 사용자의 기본 브라우저에서 연다. 실패하면 URL 안내로 복구한다. */
export async function openVerificationUrl(url: string): Promise<boolean> {
  const configured = appsEnv("OPEN_BROWSER")?.toLowerCase();
  if (configured === "0" || configured === "false" || configured === "off") {
    return false;
  }
  if (
    process.platform !== "darwin" &&
    process.platform !== "linux" &&
    process.platform !== "win32"
  ) {
    return false;
  }

  const { command, args } = browserCommandFor(process.platform, url);
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: 5_000,
      },
      (error) => resolve(error === null),
    );
  });
}
