/** HTTP readiness is separate from deployment success: never retry a deployment
 * merely because this client cannot reach the public URL. Do not follow redirects
 * or pass platform credentials to user applications. */
export async function checkPublicAccess(body: unknown) {
  if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string" || !("status" in body) || body.status !== "running") return {};
  try {
    const url = new URL(body.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid URL");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    const verified = response.status >= 200 && response.status < 400;
    return { publicAccess: { verified, httpStatus: response.status },
      ...(verified ? {} : { 안내: "배포는 실행 중이나 공개 URL의 정상 응답은 확인하지 못했다. 앱 상태와 HTTP 오류를 확인하며 곧바로 재배포하지 않는다" }) };
  } catch {
    return { publicAccess: { verified: false }, 안내: "배포는 실행 중이나 현재 클라이언트에서 공개 URL 접속을 확인하지 못했다. DNS와 TLS 및 연결 상태를 확인하며 곧바로 재배포하지 않는다" };
  }
}
