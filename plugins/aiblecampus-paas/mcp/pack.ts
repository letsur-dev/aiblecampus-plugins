import path from "node:path";
import * as tar from "tar";

/**
 * 프로젝트 디렉토리를 tar.gz 로 묶는다.
 *
 * 서버의 `src/store/sources.ts` 에 같은 구현이 있다. 그쪽을 가져다 쓰지 않는
 * 이유는 이 플러그인이 저장소 없이 단독으로 설치되기 때문이다. 플러그인 루트
 * 밖을 참조하면 설치본에서 그 경로가 존재하지 않아 기동에 실패한다.
 *
 * 두 구현이 갈리면 업로드 내용이 서버 기대와 어긋나므로 제외 목록을 함께 고친다.
 */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".data",
  ".paas-backups",
  "dist",
  ".next",
  "coverage",
  ".direnv",
]);

/** 실제 값 파일은 제외하고 키 이름만 담는 예시 env 파일은 보존한다. */
export function isSensitiveEnvName(name: string): boolean {
  if (name === ".envrc") return true;
  if (name === ".env") return true;
  if (!name.startsWith(".env.")) return false;
  return !/\.(?:example|sample|template)$/i.test(name);
}

export async function packDirectory(
  root: string,
  excludes: string[] = [],
): Promise<Buffer> {
  const skip = new Set([...SKIP, ...excludes]);

  const chunks: Buffer[] = [];
  const stream = tar.create(
    {
      gzip: true,
      cwd: root,
      // 결정적인 결과를 얻으려면 mtime 이 해시에 섞이지 않아야 한다.
      portable: true,
      noMtime: true,
      filter: (entryPath) => {
        const segments = entryPath.split(path.sep);
        return !segments.some(
          (segment) => skip.has(segment) || isSensitiveEnvName(segment),
        );
      },
    },
    ["."],
  );

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
