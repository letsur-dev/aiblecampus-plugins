# DB와 파일 Storage

## 제품 원칙

사용자는 PostgreSQL 주소, role이나 파일 backend 구조를 직접 다루지 않아야 한다. 앱에는 논리 자원만 연결하고 플랫폼이 실제 Credential과 접속 정보를 주입한다.

```text
Workspace
└── Deployment
    ├── DB
    ├── FILES
    └── Revisions
```

- DB와 파일 공간은 Deployment에 귀속한다.
- 새 Revision으로 교체해도 같은 데이터를 사용한다.
- 다른 Workspace와 Deployment의 자원에는 접근할 수 없어야 한다.
- 앱의 최종 사용자 인증과 데이터 권한은 앱 서버가 적용한다.

## 자동 연결

다음 순서로 동작한다.

1. Analyzer 결과와 앱 코드를 보고 `data`와 `files` 필요성을 판정한다.
2. 플랫폼이 필요한 논리 자원을 멱등하게 준비한다.
3. DB schema와 migration을 생성하거나 기존 방식을 보존한다.
4. 앱 서버 API와 프론트엔드 호출 코드를 연결한다.
5. 로컬 개발 Credential과 운영 Credential을 분리한다.
6. 실제 저장, 조회, 업로드와 다운로드를 검증한 뒤 배포한다.

자원만 만든 뒤 접속 정보를 사용자에게 넘기고 끝내지 않는다.

## PostgreSQL 연결

- 앱 서버는 플랫폼이 비밀값으로 주입한 `DATABASE_URL`을 사용한다.
- 브라우저에서 PostgreSQL로 직접 연결하지 않는다. 앱 내부 API를 거친다.
- 기존 ORM과 migration 방식을 유지한다. 방식이 없으면 현재 프레임워크에 맞게 추가한다.
- schema와 migration은 배포 전에 소스에 포함하고 실제 저장과 조회를 검증한다.
- `DATABASE_URL` 값을 사용자에게 출력하거나 프로젝트 파일에 기록하지 않는다.

## 파일 Storage 연결

- 앱 서버는 `PAAS_DEPLOYMENT_ID`, `PAAS_STORAGE_URL`과 비밀값 `PAAS_STORAGE_TOKEN`을 사용한다.
- 업로드나 다운로드 직전에 앱 서버가 method, deployment ID, key와 만료 시각을 HMAC-SHA256으로 서명한다.
- method는 `PUT` 또는 `GET`이고 기본 만료 시간은 5분이다.
- 앱의 자체 로그인과 파일 권한을 확인한 뒤에만 서명 URL을 브라우저에 돌려준다.
- 브라우저는 발급받은 URL로 파일을 직접 올리거나 내려받는다.
- Storage token을 브라우저, 로그, 소스와 응답에 넣지 않는다.

Node 앱의 서버 측 서명 형태는 다음과 같다.

```js
import { createHmac } from "node:crypto";

const method = "PUT";
const key = "uploads/example.png";
const expires = Math.floor(Date.now() / 1000) + 300;
const deploymentId = process.env.PAAS_DEPLOYMENT_ID;
const signature = createHmac("sha256", process.env.PAAS_STORAGE_TOKEN)
  .update(`${method}\n${deploymentId}\n${key}\n${expires}`)
  .digest("hex");
const encodedKey = key.split("/").map(encodeURIComponent).join("/");
const url =
  `${process.env.PAAS_STORAGE_URL}/v1/storage/files/` +
  `${deploymentId}/${encodedKey}?expires=${expires}&signature=${signature}`;
```

## 로컬 개발

- 로컬 PostgreSQL과 로컬 파일 디렉토리를 사용한다.
- 로컬 `.env`와 운영 Credential을 분리한다.
- 운영 `DATABASE_URL`이나 `PAAS_STORAGE_TOKEN`을 내려받아 로컬에서 쓰지 않는다.
- 저장소에는 값이 없는 예시 키와 로컬 기동 방법만 남긴다.

## 기존 영속 스택 전환

`validate_project`의 `transitions`는 실행 명령이 아니라 읽기 전용 전환 계획이다. 계획을 사용자에게 설명하고 명시적 승인을 받기 전에는 소스와 데이터를 변경하지 않는다.

### SQLite

- Prisma, Drizzle, Sequelize, TypeORM과 Knex의 기존 schema 및 migration 체계를 우선 보존한다.
- raw SQLite query만 있는 앱은 자동 호환을 가정하지 않는다. PostgreSQL schema와 query 호환성을 수동 검토하고 명시적 migration을 먼저 추가한다.
- SQLite 파일을 운영 컨테이너에 복사하는 방식은 사용하지 않는다.
- 원본 파일 checksum, table 목록과 row 수를 기록한 뒤 논리 export와 import를 수행한다.
- PostgreSQL import 후 table별 row 수와 핵심 CRUD를 비교한다.
- `preview_sqlite_transition`은 원본을 변경하지 않고 table, row 수와 checksum만 보여준다.
- 앱의 ORM migration이 빈 PostgreSQL schema를 만든 뒤 `migrate_sqlite_data`를 호출한다.
- 자동 import는 안전한 식별자, table 100개, table당 100,000행 이하의 SQLite를 지원한다. 대상 table에 데이터가 있으면 중복 import를 거부한다.

### Docker Compose PostgreSQL

- 운영 배포에서는 Compose의 PostgreSQL service를 기동하지 않는다.
- 앱이 service hostname이나 고정 접속 문자열을 사용하면 `DATABASE_URL` 기반 연결로 바꾼다.
- 기존 volume의 데이터 유무는 정적 분석으로 판단하지 않는다. `pg_dump` 미리보기로 schema, table과 예상 row 수를 먼저 확인한다.
- PostgreSQL major 버전과 extension 호환성을 확인한 뒤 플랫폼 database에 restore한다.
- 로컬 Compose는 개발 용도로 남길 수 있지만 운영 Credential을 넣지 않는다.

### 로컬 파일

- multer disk storage, `writeFile`과 `createWriteStream`으로 영속 파일을 컨테이너 경로에 두지 않는다.
- 앱 서버가 PaaS Storage 서명 URL을 발급하고 브라우저가 해당 URL로 전송하게 바꾼다.
- 기존 파일은 상대 key, 바이트 수와 checksum manifest를 만든 뒤 별도 승인 후 업로드한다.
- import 실패 시 원본 파일과 manifest를 그대로 유지한다.
- `preview_local_files_transition`으로 key, 바이트 수와 checksum을 먼저 확인한다.
- 앱을 배포해 Storage binding을 만든 뒤 `migrate_local_files`를 호출한다.
- 자동 import는 파일 1,000개와 전체 512MB까지 지원하고 기존 key와 충돌하면 덮어쓰지 않는다.

### 외부 관리형 자원

- Supabase, Firebase, S3와 다른 관리형 자원은 유지 또는 플랫폼 이전을 사용자가 선택한다.
- 유지하면 기존 SDK, Credential, 비용과 네트워크 접근을 검증한다.
- 이전하면 해당 서비스의 공식 export 절차를 사용한다.
- 서비스별 schema, ACL, metadata와 extension을 일반적인 자동 변환으로 처리하지 않는다.

### 백업과 미리보기

- 백업은 프로젝트의 `.paas-backups/`에 두고 커밋하거나 배포하지 않는다.
- 백업 경로, 생성 시각, source checksum과 예상 건수를 사용자에게 보여준다.
- 실제 import 전에 대상, 명령, 변경 건수, 검증과 복구 방법을 다시 확인한다.
- 실패 시 원본과 백업을 수정하지 않고 새 대상의 부분 결과만 정리한다.

## 지켜야 할 경계

- 데이터나 파일이 핵심 요구라면 기능을 브라우저 임시 저장으로 몰래 대체하지 않는다.
- `localStorage`는 사용자가 명시적으로 기기 안에만 저장되는 기능을 원할 때만 쓴다.
- 영속 기능을 제거해 검증을 통과시키지 않는다.
- 임의의 외부 DB나 Storage 서비스를 추가하지 않는다.
- 배포 삭제 시 영속 자원 보존 또는 삭제 선택이 필요하다는 점을 사용자에게 분명히 알린다.
- 이전 Revision과 양립할 수 없는 schema 변경은 한 번에 적용하지 않고 단계적 migration으로 나눈다.
