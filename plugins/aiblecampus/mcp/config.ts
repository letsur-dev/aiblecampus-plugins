/** Apps 환경변수의 값을 읽는다. */
export function appsEnv(name: string): string | undefined {
  return process.env[`APPS_${name}`]?.trim();
}
