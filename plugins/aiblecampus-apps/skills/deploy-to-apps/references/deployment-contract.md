# 배포 계약과 복구

## 애플리케이션 실행 계약

Node 서버는 플랫폼이 주입하는 `PORT`를 읽고 `0.0.0.0`에서 listen한다.

루트에 `index.html`이 있고 `package.json`과 Dockerfile이 없는 프로젝트는 정적 사이트로 배포한다. 플랫폼이 비특권 정적 파일 서버 이미지를 만들므로 사용자가 별도 서버 코드를 추가하지 않는다.

자체 Dockerfile은 `package.json` 없이도 사용할 수 있다. 이때 Dockerfile의 `EXPOSE` 또는 애플리케이션의 `PORT` 사용으로 healthcheck 대상 포트를 판단할 수 있어야 한다.

```js
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0");
```

- `PORT`를 일반 설정이나 비밀값으로 직접 지정하지 않는다.
- `127.0.0.1`에만 bind하면 컨테이너 밖에서 접근할 수 없다.
- 실행 명령은 foreground에서 서버 프로세스를 유지해야 한다.
- 배포에 필요한 의존성은 package manifest와 lockfile에 기록한다.
- 자체 Dockerfile은 non-root 실행, 명확한 실행 명령과 healthcheck 대상 포트를 갖춰야 한다.

## 실패 단계

| stage | 뜻 | 처리 |
| --- | --- | --- |
| `fetch` | 소스를 가져오지 못함 | 주소, `ref`, `subdir`과 public 접근 가능 여부를 확인한다 |
| `analyze` | 프로젝트 구조를 판정하지 못함 | package manifest와 실제 앱 경로를 확인한다 |
| `validate` | 실행 계약이나 안전 기준을 충족하지 못함 | 구조화된 `fix`를 적용하고 다시 검증한다 |
| `queue` | 작업 대기열 또는 실행 계층 용량이 부족함 | `details.retryable`이 true일 때만 한 번 다시 시도한다. false면 운영자 조치가 필요하다고 알린다 |
| `build` | 이미지 빌드 실패 | build 로그를 읽고 의존성, lockfile과 build 명령을 수정한다 |
| `run` | 앱 프로세스 기동 실패 | runtime 로그와 실행 명령, 필수 설정을 확인한다 |
| `health` | 앱이 제시간에 응답하지 않음 | `PORT`, bind 주소, 시작 시간과 healthcheck 경로를 확인한다 |

## 패키징과 컨테이너 검증

- 기본 Node 빌드는 package manifest와 lockfile만 복사한 뒤 의존성을 설치하고, 이후 나머지 소스를 복사한다. postinstall 또는 prepare가 로컬 스크립트나 schema 파일을 필요로 하면 해당 파일을 설치 전에 복사하는 자체 Dockerfile을 사용한다. lifecycle 스크립트를 무조건 비활성화하지 않는다.
- 자체 Dockerfile이 없다면 플랫폼 기본 빌드를 먼저 사용한다. 속도만을 이유로 앱의 실행 방식이나 파일 구성을 바꾸지 않는다.
- 자체 Dockerfile에서 별도의 `RUN chown -R`가 의존성 전체를 다시 기록하면, 설치 또는 빌드로 파일을 생성하는 RUN 안에서 소유권을 지정하고 소스는 `COPY --chown`으로 복사하는 방식을 검토한다. root 설치와 비특권 실행, 앱의 쓰기 권한을 유지한다.
- Next.js standalone 또는 다단계 빌드는 실제 프로젝트가 지원할 때 선택한다. public, static, 동적으로 읽는 파일, native 모듈과 실행 시 의존성을 확인한다. 일반 Node 앱에 standalone 구성을 강제하거나 파일을 추측해서 삭제하지 않는다.
- Docker를 실행할 수 있으면 배포할 Dockerfile로 빌드하고 같은 실행 명령과 비특권 사용자로 주요 페이지, API 및 파일 접근을 검증한다. 사용할 수 없으면 로컬 빌드와 정적 검증을 수행하고 컨테이너 검증을 했다고 보고하지 않는다.
