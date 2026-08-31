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

/** Device Flow 승인 주소를 사용자의 기본 브라우저에서 연다. 실패하면 URL 안내로 복구한다. */
export async function openVerificationUrl(url: string): Promise<boolean> {
  const configured = process.env["PAAS_OPEN_BROWSER"]?.trim().toLowerCase();
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
