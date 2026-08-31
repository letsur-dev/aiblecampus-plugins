import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import path from "node:path";
import { c as createTar } from "tar";

type SnapshotValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "real"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; value: string };

export type SqliteSnapshot = {
  version: 1;
  sourceSha256: string;
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      declaredType: string;
      notNull: boolean;
      primaryKeyOrder: number;
    }>;
    rows: SnapshotValue[][];
    checksum: string;
  }>;
  totalRows: number;
};

export type FileSnapshot = {
  sourceSha256: string;
  objects: Array<{
    key: string;
    contentType: string;
    size: number;
    sha256: string;
    base64: string;
  }>;
};

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TABLES = 100;
const MAX_ROWS = 100_000;
const MAX_FILES = 1_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sqliteIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`지원하지 않는 SQLite 식별자다: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function snapshotValue(value: unknown): SnapshotValue {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint") {
    return { type: "integer", value: value.toString() };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "real", value };
  }
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Uint8Array) {
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  }
  throw new Error(`지원하지 않는 SQLite 값 형식이다: ${typeof value}`);
}

export async function snapshotSqlite(databasePath: string): Promise<SqliteSnapshot> {
  const absolute = path.resolve(databasePath);
  const source = await readFile(absolute);
  const database = new DatabaseSync(absolute, { readOnly: true });
  try {
    const tableStatement = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tables = tableStatement.all() as Array<{ name: string }>;
    if (tables.length === 0) throw new Error("이전할 SQLite table이 없다");
    if (tables.length > MAX_TABLES) {
      throw new Error(`SQLite table은 ${MAX_TABLES}개까지 자동 이전할 수 있다`);
    }

    const snapshots: SqliteSnapshot["tables"] = [];
    let totalRows = 0;
    for (const { name } of tables) {
      const identifier = sqliteIdentifier(name);
      const columns = database.prepare(`PRAGMA table_info(${identifier})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      if (columns.length === 0 || columns.length > 100) {
        throw new Error(`SQLite ${name} table의 열 구성을 지원하지 않는다`);
      }
      for (const column of columns) sqliteIdentifier(column.name);
      const order = columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => sqliteIdentifier(column.name));
      if (order.length === 0) {
        order.push(...columns.map((column) => sqliteIdentifier(column.name)));
      }
      const statement = database.prepare(
        `SELECT * FROM ${identifier} ORDER BY ${order.join(", ")}`,
      );
      statement.setReadBigInts(true);
      const rawRows = statement.all() as Array<Record<string, unknown>>;
      if (rawRows.length > MAX_ROWS) {
        throw new Error(`SQLite table당 ${MAX_ROWS}행까지 자동 이전할 수 있다`);
      }
      const rows = rawRows.map((row) =>
        columns.map((column) => snapshotValue(row[column.name])),
      );
      totalRows += rows.length;
      snapshots.push({
        name,
        columns: columns.map((column) => ({
          name: column.name,
          declaredType: column.type,
          notNull: column.notnull === 1,
          primaryKeyOrder: column.pk,
        })),
        rows,
        checksum: sha256(JSON.stringify(rows)),
      });
    }
    return {
      version: 1,
      sourceSha256: sha256(source),
      tables: snapshots,
      totalRows,
    };
  } finally {
    database.close();
  }
}

export function withinProject(projectRoot: string, candidate: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("이전 대상은 프로젝트 폴더 안에 있어야 한다");
  }
  return absolute;
}

function backupName(label: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${label}${extension}`;
}

export async function backupAndSnapshotSqlite(
  projectRoot: string,
  databasePath: string,
): Promise<{ backupPath: string; snapshot: SqliteSnapshot }> {
  const source = withinProject(projectRoot, databasePath);
  const backupRoot = path.join(path.resolve(projectRoot), ".paas-backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupPath = path.join(
    backupRoot,
    backupName(path.basename(source), ".sqlite"),
  );
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, backupPath);
  } finally {
    database.close();
  }
  return { backupPath, snapshot: await snapshotSqlite(backupPath) };
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".txt" || extension === ".md") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

async function collectFiles(
  root: string,
  current: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      throw new Error(`파일은 ${MAX_FILES}개까지 자동 이전할 수 있다`);
    }
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`심볼릭 링크는 자동 이전하지 않는다: ${absolute}`);
    }
    if (entry.isDirectory()) await collectFiles(root, absolute, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
}

export async function snapshotFiles(sourceDirectory: string): Promise<FileSnapshot> {
  const root = path.resolve(sourceDirectory);
  const files: string[] = [];
  await collectFiles(root, root, files);
  files.sort();
  const objects: FileSnapshot["objects"] = [];
  let totalBytes = 0;
  for (const key of files) {
    const absolute = path.join(root, key);
    const info = await stat(absolute);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("파일 이전 전체 크기는 512MB 이하여야 한다");
    }
    const content = await readFile(absolute);
    objects.push({
      key: key.split(path.sep).join("/"),
      contentType: contentType(key),
      size: content.byteLength,
      sha256: sha256(content),
      base64: content.toString("base64"),
    });
  }
  return {
    sourceSha256: sha256(
      JSON.stringify(
        objects.map(({ key, size, sha256: objectSha }) => ({
          key,
          size,
          sha256: objectSha,
        })),
      ),
    ),
    objects,
  };
}

export async function backupAndSnapshotFiles(
  projectRoot: string,
  sourceDirectory: string,
): Promise<{ backupPath: string; snapshot: FileSnapshot }> {
  const source = withinProject(projectRoot, sourceDirectory);
  const backupRoot = path.join(path.resolve(projectRoot), ".paas-backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupPath = path.join(
    backupRoot,
    backupName(path.basename(source), ".tar.gz"),
  );
  await createTar(
    { cwd: source, file: backupPath, gzip: true, portable: true },
    ["."],
  );
  return { backupPath, snapshot: await snapshotFiles(source) };
}
