# CLAUDE.md — DS Historian 서버 개발 지시 명세서

> **작성자**: 수석 아키텍트
> **수신자**: Claude Code
> **버전**: v1.0 (2026-04-16)
> **작업 성격**: TypeScript (Node.js) Historian 시계열 적재 서버 코드 작성
> **저장소**: historian (Historian 서버 전용)

---

## 0. 프로젝트 컨텍스트

### 0.1 너의 역할
너는 15년 차 제조 IT(MES/스마트 팩토리) 도메인의 수석 개발자로서, DS 주식회사 비전 검사 장비의 **Historian 시계열 적재 서버**를 TypeScript(Node.js)로 구현한다. 이 서버는 Broker에서 수신한 8종 이벤트를 TimescaleDB에 적재하여 Oracle/AI 서버에 원시 데이터를 공급하는 **읽기 전용 데이터 수집 서버**이다.

### 0.2 프로젝트의 본질
- 망 분리된 반도체 후공정 공장 현장에서, N대의 비전 검사 장비(EAP)를 모니터링
- 통신: MQTT v5.0 (Eclipse Mosquitto 2.x) over Local Wi-Fi
- 핵심 가치: **데이터 병목 없는 파이프라인** + 시계열 데이터 무결성
- Historian은 **"저장"만** 수행한다. 판정(Oracle), 보안 전송(Dispatcher), 분석(AI)은 다른 서버의 책임

### 0.3 시스템 내 위치

```
가상 EAP 서버 (C#, MQTTnet)
        │
        │  MQTT Publish (8종 이벤트, JSON)
        ▼
   Eclipse Mosquitto Broker (로컬 Wi-Fi)
        │
        ├──→ 모바일 앱 (Flutter) ── 실시간 N:1 타일 모니터링
        ├──→ Historian 서버 (본 프로젝트) ←── 너가 만드는 것
        │        │
        │        ├──→ Oracle 서버 (Python) ── TSDB 경유 일괄 조회
        │        └──→ Dispatcher 서버 (Node.js) ── read-only 조회 → AI 서버
        │
        ├──→ Oracle 서버 (Python) ── LOT_END 직접 구독 (트리거)
        └──→ MES 서버 (C#) ── 중앙 제어

[Historian은 Subscribe-only. Publish 없음.]
```

### 0.4 작업 시작 전 필독 문서

작업을 시작하기 전에 **반드시 아래 문서를 순서대로 읽어서 컨텍스트를 머릿속에 적재**한다. 이걸 건너뛰면 PASS drop 정책, 스키마 설계, enrichment 로직을 잘못 구현할 위험이 있다.

1. **`./명세서/Historian_작업명세서.md`** — **Historian 서버 작업 명세서 (1차 구현 설계도)**
   - TimescaleDB 스키마 DDL, PASS drop 정책, 배치 INSERT, Graceful Shutdown
   - 프로젝트 구조, 환경변수, Docker Compose, 검증 체크리스트
   - ⚠️ **이 문서가 Historian 구현의 직접적인 설계도**. 코드 작성 전 반드시 전체 통독

2. **`../DS-Document/명세서/DS_EAP_MQTT_API_명세서.md`** — MQTT API 전체 명세 (v3.4 확정, **충돌 시 최우선 문서**)
   - 8종 이벤트 페이로드 필드 정의, QoS/Retained 정책
   - PASS drop 정책 원본 (§4), Retained Message 정책 (§1.1.1)

3. **`../EAP_VM/명세서/eap-spec-v1.md`** — 가상 EAP 작업 명세서
   - Mock 데이터 27종 인덱스, PASS drop 구독자별 정책표 (§4.3)
   - 이벤트 시퀀스, ALARM_ACK 빈 페이로드 clear 메커니즘

4. **`../DS-Document/명세서/DS_이벤트정의서.md`** — Rule 38개 판정 기준
   - Oracle 연동 시 hw_error_code 매핑 참조

5. **`../DS-Document/문서/오라클 2차 검증 기획안.md`** — Oracle이 Historian에 요구하는 쿼리 패턴
   - EWMA+MAD / Isolation Forest가 TSDB에 기대하는 데이터 구조

> **💡 Claude Code 사용 패턴**: 작업 전에 `./명세서/Historian_작업명세서.md`, `../DS-Document/명세서/DS_EAP_MQTT_API_명세서.md`, `../EAP_VM/명세서/eap-spec-v1.md`를 순서대로 읽고 컨텍스트를 적재하라.

### 0.5 문서 간 충돌 시 우선순위

> **API 명세서 v3.4 > Historian 작업명세서 v1.0 > eap-spec-v1 > 이벤트 정의서 v1.0**

### 0.6 인접 저장소 구조 (필수 전제)

이 저장소(Historian)는 DS-Document 저장소의 문서와 Mock 데이터를 **상대경로(`../DS-Document/`)로 직접 참조**한다. 파일을 복사하지 않는다. 아래 디렉토리 구조가 갖춰져 있어야 한다. 없으면 작업을 시작하지 말고 사용자에게 알려라.

```
C:\Hansung_Project\WebCapstone\        ← 공통 부모 디렉토리
├── DS-Document/                       ← 문서·Mock 원본 저장소
│   ├── 명세서/
│   │   ├── DS_EAP_MQTT_API_명세서.md   ← MQTT API 전체 명세 v3.4
│   │   └── DS_이벤트정의서.md           ← 이벤트 분류 체계 + Rule 38개
│   ├── 문서/
│   │   ├── 기획안.md                   ← 시스템 아키텍처
│   │   └── 오라클 2차 검증 기획안.md    ← Oracle 쿼리 패턴
│   └── EAP_mock_data/
│       ├── 01_heartbeat.json ~ 27_control_alarm_ack_burst.json
│       ├── README.md
│       └── scenarios/
│           └── multi_equipment_4x.json
├── EAP_VM/                            ← 가상 EAP 서버 (C#)
│   └── 명세서/
│       └── eap-spec-v1.md             ← 가상 EAP 서버 작업 명세서
├── Historian/                         ← 이 저장소 (Historian 개발)
│   ├── .claude/
│   │   └── CLAUDE.md                  ← 이 파일
│   └── 명세서/
│       └── Historian_작업명세서.md      ← Historian 1차 설계도 ★
├── mosquitto_config/                  ← Broker 설정
└── MQTT/                             ← MQTT 관련
```

> **주의:** DS-Document의 문서와 Mock 데이터는 읽기 전용 참조 자원이다. Historian에서 직접 수정하지 말 것.

---

## 1. 작업 원칙 (모든 Task 공통)

### 1.1 기술 스택 고정

| 항목 | 기술 | 이유 |
|:---|:---|:---|
| 언어 | TypeScript (Node.js) | 기획서 확정 스택 |
| MQTT 라이브러리 | mqtt.js (v5) | Node.js 표준 MQTT 클라이언트 |
| DB | PostgreSQL + TimescaleDB | 시계열 데이터 최적화 |
| DB 드라이버 | pg (node-postgres) | 커넥션 풀링, COPY 지원 |
| 로깅 | pino | 구조적 JSON 로깅, 고성능 |
| 환경변수 | dotenv | .env 파일 기반 설정 |
| 테스트 | vitest 또는 jest | 단위/통합 테스트 |

### 1.2 MQTT 정책 필수 준수 (코드에 반드시 반영)

#### 1.2.1 구독 QoS 정책

| QoS | 대상 토픽 | 이유 |
|:---|:---|:---|
| QoS 1 | `ds/+/heartbeat`, `ds/+/status`, `ds/+/result` | 주기적 발행, 1회 누락 허용 |
| QoS 2 | `ds/+/lot`, `ds/+/alarm`, `ds/+/recipe`, `ds/+/control`, `ds/+/oracle` | 정확히 1회 전달 보장 필수 |

#### 1.2.2 세션 정책

```typescript
// MQTT 연결 옵션 필수 설정
{
  clean: false,              // clean_start=false (세션 유지, 재연결 시 큐 보존)
  clientId: 'ds_historian_001',
  properties: {
    sessionExpiryInterval: 3600,  // 1시간 재연결 여유 (명세서 §5.1)
  },
  keepalive: 60,             // 60초 (명세서 §5.1)
  // Will 메시지 없음 — Historian은 Subscribe-only, Will은 Publisher 전용
}
```

#### 1.2.3 재연결 백오프

```
1s → 2s → 5s → 15s → 30s, max 60s, jitter ±20%
```

코드에 백오프 + jitter 로직을 반드시 포함할 것. mqtt.js 내장 재연결 대신 커스텀 백오프 구현.

#### 1.2.4 빈 페이로드 처리

ALARM_ACK 시 EAP가 `ds/{eq}/alarm` 토픽에 빈 페이로드 + Retain=true를 발행하여 retained message를 clear한다. Historian은 **빈 페이로드 수신 시 적재하지 않고 무시**해야 한다. 이것은 Broker의 retained 상태를 정리하는 제어 신호일 뿐이다.

#### 1.2.5 ACL 제약

| 항목 | 값 |
|:---|:---|
| 계정 | `historian` |
| Subscribe 허용 | `ds/#` (전체 읽기) |
| Publish 허용 | **없음** (읽기 전용) |

코드에서 절대 `client.publish()` 를 호출하지 말 것.

### 1.3 PASS drop 적재 정책 (핵심 병목 방지)

> **규칙:** `overall_result = PASS AND fail_count = 0`이면, `inspection_detail` / `geometric` / `bga` / `surface` / `singulation` 그룹을 **적재하지 않는다**. `summary` + `process` 그룹만 적재한다.

| 조건 | 적재 범위 | 예상 부하 감소 |
|:---|:---|:---|
| PASS (fail_count = 0) | summary + process만 | 적재 부하 ~60% 감소 |
| FAIL (fail_count ≥ 1) | 전체 필드 적재 | 전체 적재 |

### 1.4 Enrichment 정책

- Historian은 장비별 마지막 `STATUS_UPDATE`의 `recipe_id`, `operator_id`를 **인메모리 캐시**에 유지
- `LOT_END` 수신 시 해당 `equipment_id`의 캐시 값을 `lot_ends.recipe_id`, `lot_ends.operator_id`에 주입
- 캐시 미존재 시: `recipe_id='UNKNOWN'` 적재 + WARN 로그 출력
- 이 enrichment는 Oracle의 레시피별 수율 쿼리를 3-way JOIN 없이 단일 테이블 쿼리로 해결하기 위해 필수

---

## 2. 프로젝트 구조 (권장)

```
Historian/
├── .claude/
│   └── CLAUDE.md                          ← 이 파일
├── src/
│   ├── index.ts                           ← 엔트리포인트, Graceful Shutdown
│   ├── config/
│   │   └── env.ts                         ← 환경변수 로딩 (.env)
│   ├── mqtt/
│   │   ├── client.ts                      ← MQTT 클라이언트 (커스텀 재연결 백오프)
│   │   ├── router.ts                      ← 토픽 → 핸들러 라우팅
│   │   └── subscriptions.ts               ← 구독 토픽 + QoS 정의
│   ├── handlers/
│   │   ├── heartbeat.handler.ts
│   │   ├── status.handler.ts              ← 인메모리 캐시 갱신
│   │   ├── inspection.handler.ts          ← PASS drop 정책 구현 (핵심)
│   │   ├── lot-end.handler.ts             ← recipe_id enrichment (STATUS 캐시 참조)
│   │   ├── alarm.handler.ts               ← 빈 페이로드 무시 로직 포함
│   │   ├── recipe.handler.ts
│   │   ├── control.handler.ts             ← 감사 로그 적재
│   │   └── oracle.handler.ts
│   ├── db/
│   │   ├── pool.ts                        ← pg Pool 초기화 (max: 10)
│   │   ├── schema.sql                     ← DDL (Hypertable + 인덱스 + Retention)
│   │   └── batch-inserter.ts              ← 배치 INSERT 유틸 (100건 or 1초)
│   └── utils/
│       ├── logger.ts                      ← 구조적 로깅 (pino)
│       ├── backoff.ts                     ← 재연결 백오프 유틸 [1,2,5,15,30,60] + jitter ±20%
│       └── equipment-cache.ts             ← 장비별 STATUS 캐시 (Map<string, CachedStatus>)
├── test/
│   ├── handlers/
│   │   ├── inspection.handler.test.ts     ← PASS drop 정책 단위 테스트
│   │   └── lot-end.handler.test.ts        ← enrichment 단위 테스트
│   └── mqtt/
│       └── client.test.ts                 ← 재연결 백오프 단위 테스트
├── docker-compose.yml                     ← TimescaleDB + Historian 로컬 개발 환경
├── .env.example
├── tsconfig.json
├── package.json
└── README.md
```

---

## 3. Task 실행 순서

의존성에 따라 아래 순서로 진행한다. **각 Task 끝에 검증 체크리스트를 통과해야 다음 Task로.**

| 순서 | Task ID | 제목 | 우선순위 | 예상 | 의존성 |
|:---|:---|:---|:---|:---|:---|
| 1 | H1 | 프로젝트 초기 설정 (TypeScript, 패키지, 설정) | P0 | 0.5일 | 없음 |
| 2 | H2 | TimescaleDB 스키마 DDL + Docker Compose | P0 | 0.5일 | 없음 |
| 3 | H3 | MQTT 클라이언트 (재연결 백오프 + 구독) | P0 | 0.5일 | H1, Broker 기동 |
| 4 | H4 | 메시지 라우터 (토픽 → 핸들러 매핑) | P0 | 0.5일 | H3 |
| 5 | H5 | INSPECTION_RESULT 핸들러 (PASS drop 정책) | P0 | 1일 | H2, H4 |
| 6 | H6 | 나머지 7종 이벤트 핸들러 | P1 | 1일 | H2, H4 |
| 7 | H11 | 장비별 STATUS 캐시 + LOT_END enrichment | P0 | 0.5일 | H4, H6 |
| 8 | H7 | 배치 INSERT 최적화 | P1 | 0.5일 | H5 |
| 9 | H8 | Graceful Shutdown | P1 | 0.5일 | H3, H7 |
| 10 | H9 | Continuous Aggregate (수율 사전 집계) | P2 | 0.5일 | H2, H6 |
| 11 | H10 | 통합 테스트 (Mock 데이터 27종 전수 적재 검증) | P1 | 1일 | H5, H6, H11 |

> **주의:** H11(enrichment)은 H6(핸들러) 이후에 배치되지만 P0이다. STATUS 캐시가 없으면 LOT_END의 recipe_id가 UNKNOWN으로 적재되어 Oracle 쿼리가 무의미해진다.

---

## 4. Task H1 — 프로젝트 초기 설정

### 4.1 작업 목표
TypeScript 프로젝트 생성, 패키지 의존성 설치, ESLint/tsconfig 설정, .env.example 생성.

### 4.2 핵심 구현 사항

- `package.json`: mqtt, pg, pino, dotenv, typescript, @types/*
- `tsconfig.json`: strict 모드, ES2022 target, Node16 module
- `.env.example`: Historian 작업명세서 §10 환경변수 구조 그대로 반영
- `src/config/env.ts`: 환경변수 로딩 + 검증 (필수값 누락 시 프로세스 종료)

### 4.3 검증 체크리스트
- [ ] `npm install` 성공
- [ ] `npx tsc --noEmit` 타입 체크 통과
- [ ] `.env.example` 파일에 MQTT_BROKER_URL, TSDB_HOST 등 전 항목 포함
- [ ] `env.ts`에서 필수 환경변수 누락 시 에러 메시지 + `process.exit(1)`

### 4.4 Git 커밋 메시지
```
feat(historian): 프로젝트 초기 설정 (H1)

- TypeScript + Node.js 프로젝트 스캐폴딩
- 의존성: mqtt, pg, pino, dotenv
- .env.example: Broker/TSDB/배치 설정
- env.ts: 환경변수 로딩 + 필수값 검증
```

---

## 5. Task H2 — TimescaleDB 스키마 DDL + Docker Compose

### 5.1 작업 목표
Historian 작업명세서 §4의 8개 Hypertable DDL을 `src/db/schema.sql`에 작성하고, `docker-compose.yml`로 TimescaleDB 로컬 환경을 구성한다.

### 5.2 핵심 구현 사항

- `schema.sql`: 8개 테이블 (heartbeats, status_updates, inspection_results, lot_ends, hw_alarms, recipe_changes, control_commands, oracle_analyses)
- 각 테이블 `create_hypertable()` 호출 + 복합 인덱스 생성
- Retention Policy: heartbeat/status 90일, 나머지 365일
- Continuous Aggregate: `lot_yield_hourly` (선택적, H9에서 정식 적용)
- `docker-compose.yml`: TimescaleDB 컨테이너 + healthcheck + schema.sql 초기화

### 5.3 검증 체크리스트
- [ ] `docker-compose up -d` 성공
- [ ] `psql`로 접속 → 8개 Hypertable 존재 확인
- [ ] 인덱스 목록이 Historian 작업명세서 §4.2와 일치
- [ ] Retention Policy 등록 확인 (`SELECT * FROM timescaledb_information.jobs`)
- [ ] `schema.sql`을 두 번 실행해도 에러 없음 (`IF NOT EXISTS` 방어)

### 5.4 Git 커밋 메시지
```
feat(historian): TimescaleDB 스키마 DDL + Docker Compose (H2)

- 8개 Hypertable (heartbeats ~ oracle_analyses)
- 복합 인덱스: equipment_id+time, recipe_id+time 등
- Retention: heartbeat/status 90일, 나머지 365일
- Docker Compose: TimescaleDB + healthcheck + 초기화
```

---

## 6. Task H3 — MQTT 클라이언트 (재연결 백오프 + 구독)

### 6.1 작업 목표
mqtt.js 기반 MQTT 클라이언트 구현. 커스텀 재연결 백오프, `ds/#` 전체 구독, `clean: false` 세션 유지.

### 6.2 핵심 구현 사항

- `mqtt/client.ts`: mqtt.js 연결 + 커스텀 백오프 (mqtt.js 내장 재연결 비활성화)
- `utils/backoff.ts`: 백오프 수열 `[1, 2, 5, 15, 30, 60]`, jitter ±20% 계산 함수
- `mqtt/subscriptions.ts`: 토픽별 QoS 매핑 테이블
- 연결 성공 시 `ds/#` 구독 (개별 토픽 QoS 지정)
- **Will 메시지 없음** — Historian은 Subscribe-only

### 6.3 재연결 백오프 구현 참조

```typescript
const BACKOFF_STEPS = [1, 2, 5, 15, 30, 60]; // 초 단위
const JITTER_RATIO = 0.2; // ±20%

function getBackoffMs(attempt: number): number {
  const step = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)];
  const jitter = step * JITTER_RATIO * (Math.random() * 2 - 1);
  return (step + jitter) * 1000;
}
```

### 6.4 검증 체크리스트
- [ ] Mosquitto 로컬 Broker에 연결 성공 로그 출력
- [ ] `historian` 계정으로 인증 (`username: 'historian'`)
- [ ] `clean: false` 설정 확인 (재연결 시 큐 보존)
- [ ] 의도적 Broker 중단 → 재연결 백오프 로그 확인 (1s→2s→5s→15s→30s→60s)
- [ ] jitter가 적용되어 매 재연결 간격이 미세하게 다름
- [ ] 재연결 성공 후 구독 복원 확인

### 6.5 Git 커밋 메시지
```
feat(historian): MQTT 클라이언트 + 재연결 백오프 (H3)

- mqtt.js 연결: clean=false, historian 계정
- 커스텀 백오프: [1,2,5,15,30,60]s + jitter ±20%
- ds/# 구독: 토픽별 QoS 1/2 개별 지정
- Will 메시지 없음 (Subscribe-only)
```

---

## 7. Task H4 — 메시지 라우터 (토픽 → 핸들러 매핑)

### 7.1 작업 목표
수신 MQTT 메시지의 토픽을 파싱하여 적절한 핸들러로 라우팅한다.

### 7.2 핵심 구현 사항

- `mqtt/router.ts`: 토픽 패턴 → 핸들러 매핑
  - `ds/{eq}/heartbeat` → `heartbeat.handler`
  - `ds/{eq}/status` → `status.handler`
  - `ds/{eq}/result` → `inspection.handler`
  - `ds/{eq}/lot` → `lot-end.handler`
  - `ds/{eq}/alarm` → `alarm.handler`
  - `ds/{eq}/recipe` → `recipe.handler`
  - `ds/{eq}/control` → `control.handler`
  - `ds/{eq}/oracle` → `oracle.handler`
- 토픽에서 `equipment_id` 추출 (`ds/{equipment_id}/xxx`)
- **빈 페이로드 사전 필터링**: payload.length === 0이면 라우팅하지 않고 무시 (ALARM_ACK retained clear 신호)
- 미인식 토픽 → WARN 로그 + 무시 (에러 아님)

### 7.3 검증 체크리스트
- [ ] 8종 토픽 모두 올바른 핸들러로 라우팅
- [ ] 토픽에서 `equipment_id` 정확 추출 (`ds/DS-VIS-001/status` → `DS-VIS-001`)
- [ ] 빈 페이로드 수신 시 핸들러 호출 없이 무시 + DEBUG 로그
- [ ] 미인식 토픽 (`ds/unknown/xxx`) → WARN 로그, 크래시 없음

### 7.4 Git 커밋 메시지
```
feat(historian): 메시지 라우터 — 토픽→핸들러 매핑 (H4)

- 8종 토픽 → 핸들러 라우팅
- equipment_id 토픽 추출
- 빈 페이로드 사전 필터링 (ALARM_ACK retained clear)
- 미인식 토픽 WARN 로그
```

---

## 8. Task H5 — INSPECTION_RESULT 핸들러 (PASS drop 정책)

### 8.1 작업 목표
INSPECTION_RESULT 페이로드를 파싱하여 PASS drop 정책에 따라 조건부 적재한다. **Historian에서 가장 중요한 핸들러**.

### 8.2 핵심 구현 사항

- PASS 판정 (`overall_result === 'PASS' && fail_count === 0`):
  - summary + process 그룹만 적재
  - detail 관련 컬럼(inspection_detail, geometric, bga, surface, singulation) 모두 NULL
- FAIL 판정:
  - 전체 필드 적재
  - `inspection_detail`은 **JSONB로 그대로 저장** (PascalCase 변환 금지)
- `inspection_detail` 내부 필드는 PascalCase (GVisionWpf 원본) → JSONB 컬럼에 원본 그대로 저장
- 적재 대상 필드는 Historian 작업명세서 §3.2 참조

### 8.3 검증 체크리스트
- [ ] Mock 04 (PASS) → detail 관련 컬럼 전부 NULL, summary+process 정상 적재
- [ ] Mock 05 (FAIL ET=52) → 전체 필드 정상 적재, singulation 값 일치
- [ ] Mock 06 (FAIL ET=12) → 전체 필드 적재, `inspection_detail` JSONB에 PascalCase 유지
- [ ] Mock 07 (FAIL ET=11 3/8) → partial FAIL, 전체 적재
- [ ] Mock 08 (FAIL 혼재) → ET=52+12 혼재, 전체 적재
- [ ] `inspection_detail.prs_result[].ZAxisNum` PascalCase가 JSONB에서 보존됨

### 8.4 Git 커밋 메시지
```
feat(historian): INSPECTION_RESULT 핸들러 + PASS drop 정책 (H5)

- PASS: summary + process만 적재 (detail NULL), 부하 ~60% 감소
- FAIL: 전체 필드 적재 (inspection_detail JSONB PascalCase 유지)
- Mock 04~08 적재 검증 완료
```

---

## 9. Task H6 — 나머지 7종 이벤트 핸들러

### 9.1 작업 목표
HEARTBEAT, STATUS_UPDATE, LOT_END, HW_ALARM, RECIPE_CHANGED, CONTROL_CMD, ORACLE_ANALYSIS 핸들러 구현.

### 9.2 핸들러별 주의사항

| 핸들러 | 주의사항 |
|:---|:---|
| `heartbeat.handler` | 경량 (message_id, equipment_id, timestamp 3필드) |
| `status.handler` | 진행률 3필드 nullable (`current_unit_count`, `expected_total_units`, `current_yield_pct`). **인메모리 캐시 갱신** (H11에서 정식 구현, 여기서는 인터페이스 준비) |
| `lot-end.handler` | `recipe_id` enrichment 필요 (H11에서 구현). 여기서는 페이로드 그대로 적재, enrichment 슬롯만 준비 |
| `alarm.handler` | `burst_id`/`burst_count` nullable. `payload_raw` JSONB로 원본 전체 보존. **빈 페이로드 무시** (H4 라우터에서 선필터링) |
| `recipe.handler` | `equipment_status`는 항상 IDLE (비정상 전환 감지용 적재) |
| `control.handler` | 감사 로그 목적. `target_burst_id` nullable |
| `oracle.handler` | `isolation_forest_score`, `threshold_proposal` nullable |

### 9.3 검증 체크리스트
- [ ] Mock 01 (HEARTBEAT) 적재 → 3필드 정상
- [ ] Mock 02 (STATUS RUN) 적재 → 진행률 3필드 포함
- [ ] Mock 03 (STATUS IDLE) 적재 → 진행률 3필드 null 허용
- [ ] Mock 09 (LOT_END normal) 적재 → yield_pct=96.2, total_units=2792
- [ ] Mock 10 (LOT_END aborted) 적재 → lot_status=ABORTED
- [ ] Mock 11~17 (HW_ALARM 7종) 적재 → alarm_level, hw_error_source 정상
- [ ] Mock 16 (burst) → burst_id/burst_count 적재 (시나리오 러너 경유 시). Mock 직접 적재 시 burst_id=NULL 정상
- [ ] Mock 18~20 (RECIPE_CHANGED 3종) → equipment_status=IDLE
- [ ] Mock 21~22 (CONTROL_CMD) → command, issued_by 정상
- [ ] Mock 23~25 (ORACLE_ANALYSIS 3종) → judgment 값 일치

### 9.4 Git 커밋 메시지
```
feat(historian): 7종 이벤트 핸들러 (H6)

- HEARTBEAT / STATUS_UPDATE / LOT_END / HW_ALARM
- RECIPE_CHANGED / CONTROL_CMD / ORACLE_ANALYSIS
- Mock 01~27 전종 적재 호환
```

---

## 10. Task H11 — 장비별 STATUS 캐시 + LOT_END enrichment

### 10.1 작업 목표
장비별 STATUS_UPDATE의 `recipe_id`, `operator_id`를 인메모리 캐시에 유지하고, LOT_END 적재 시 enrichment한다.

### 10.2 핵심 구현 사항

- `utils/equipment-cache.ts`: `Map<string, { recipe_id: string, operator_id: string }>`
- `status.handler`에서 캐시 갱신 (`equipment_id` → recipe_id, operator_id 저장)
- `lot-end.handler`에서 캐시 조회 → `lot_ends.recipe_id`, `lot_ends.operator_id` 주입
- 캐시 미존재 시: `recipe_id = 'UNKNOWN'`, `operator_id = 'UNKNOWN'` + WARN 로그

### 10.3 검증 체크리스트
- [ ] STATUS_UPDATE 수신 → 캐시에 recipe_id/operator_id 갱신 확인
- [ ] LOT_END 수신 → 캐시에서 recipe_id 추출하여 적재
- [ ] 캐시 미존재 상태에서 LOT_END 수신 → 'UNKNOWN' 적재 + WARN 로그
- [ ] 4대 장비 동시 구동 시 각 장비 캐시 독립 유지

### 10.4 Git 커밋 메시지
```
feat(historian): STATUS 캐시 + LOT_END enrichment (H11)

- equipment-cache: Map<equipmentId, { recipe_id, operator_id }>
- status.handler: 캐시 자동 갱신
- lot-end.handler: enrichment 주입 (미존재 시 UNKNOWN + WARN)
```

---

## 11. Task H7 — 배치 INSERT 최적화

### 11.1 작업 목표
INSPECTION_RESULT의 높은 유입 빈도(~2.5건/초)를 처리하기 위한 배치 INSERT 구현.

### 11.2 핵심 구현 사항

- `db/batch-inserter.ts`: 버퍼링 후 일괄 INSERT
  - `BATCH_SIZE = 100` (환경변수 오버라이드 가능)
  - `FLUSH_INTERVAL_MS = 1000` (환경변수 오버라이드 가능)
  - 100건 도달 또는 1초 경과 중 먼저 도달 시 플러시
- pg `COPY` 또는 multi-row INSERT VALUES 사용
- 플러시 실패 시 재시도 (1회) → 실패 시 에러 로그 + 버퍼 드롭 (OOM 방지)

### 11.3 검증 체크리스트
- [ ] 100건 연속 유입 → 1회 배치 INSERT 실행 확인
- [ ] 50건 유입 후 1초 경과 → 타이머 플러시 실행 확인
- [ ] 플러시 중 신규 메시지 유입 → 별도 버퍼에 축적 (블로킹 없음)
- [ ] Graceful Shutdown 시 잔여 버퍼 플러시 확인

### 11.4 Git 커밋 메시지
```
feat(historian): 배치 INSERT 최적화 (H7)

- BatchInserter: 100건 or 1초 플러시
- multi-row INSERT / COPY 선택
- 플러시 실패 재시도 1회 + 드롭 안전장치
```

---

## 12. Task H8 — Graceful Shutdown

### 12.1 작업 목표
SIGTERM/SIGINT 수신 시 배치 플러시 → MQTT 해제 → DB 풀 해제 순서로 안전 종료.

### 12.2 핵심 구현 사항

```typescript
// 종료 시퀀스 (5초 타임아웃)
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, starting graceful shutdown...`);
  // 1. 배치 버퍼 플러시 (잔여 데이터 적재)
  await batchInserter.flush();
  // 2. MQTT 연결 해제
  await mqttClient.endAsync(true); // force=true
  // 3. DB 커넥션 풀 해제
  await pool.end();
  process.exit(0);
}
```

- `process.on('SIGTERM', ...)`, `process.on('SIGINT', ...)`
- 5초 타임아웃: `Promise.race([shutdown, timeout])` → 타임아웃 시 `process.exit(1)`

### 12.3 검증 체크리스트
- [ ] Ctrl+C → 배치 플러시 로그 → MQTT 해제 로그 → DB 해제 로그 → 종료
- [ ] 배치 버퍼에 잔여 데이터 있을 때 종료 → 플러시 후 종료 확인
- [ ] 5초 타임아웃 초과 시 강제 종료 (exit code 1)

### 12.4 Git 커밋 메시지
```
feat(historian): Graceful Shutdown (H8)

- SIGTERM/SIGINT: 배치 플러시 → MQTT 해제 → DB 해제
- 5초 타임아웃 강제 종료 안전장치
```

---

## 13. Task H9 — Continuous Aggregate (수율 사전 집계)

### 13.1 작업 목표
Oracle 서버의 빈번한 레시피별 수율 쿼리를 가속화하기 위한 사전 집계 뷰 생성.

### 13.2 핵심 구현 사항

- `lot_yield_hourly` Continuous Aggregate (Historian 작업명세서 §4.4 참조)
- 1시간 버킷, equipment_id + recipe_id 그룹핑
- avg/min/max yield, lot_count, avg_duration

### 13.3 검증 체크리스트
- [ ] `lot_yield_hourly` 뷰 생성 확인
- [ ] LOT_END 적재 후 1시간 뒤 집계 데이터 존재 확인
- [ ] `SELECT * FROM lot_yield_hourly WHERE recipe_id = 'Carsem_3X3'` 정상 반환

### 13.4 Git 커밋 메시지
```
feat(historian): Continuous Aggregate — lot_yield_hourly (H9)

- 1시간 버킷 수율 사전 집계
- Oracle EWMA+MAD 쿼리 가속화
```

---

## 14. Task H10 — 통합 테스트 (Mock 27종 전수 적재 검증)

### 14.1 작업 목표
Mock 데이터 27종을 전수 적재하여 데이터 정합성 검증.

### 14.2 통합 테스트 시나리오

1. **PASS drop 검증**: Mock 04 → detail NULL, process 정상
2. **FAIL 전체 적재**: Mock 05~08 → 전체 필드, PascalCase JSONB
3. **LOT_END enrichment**: Mock 09 → recipe_id=Carsem_3X3 (STATUS 캐시 경유)
4. **HW_ALARM 7종**: Mock 11~17 → alarm_level, burst_id 정합
5. **CONTROL_CMD 감사 로그**: Mock 21~22, 26~27 → command, issued_by
6. **ORACLE_ANALYSIS 3종**: Mock 23~25 → judgment 값
7. **Oracle 연동 쿼리 5종**: Historian 작업명세서 §12.5 쿼리 전수 실행

### 14.3 검증 체크리스트
- [ ] 27종 Mock 전수 적재 성공 (에러 0건)
- [ ] PASS drop: detail 컬럼 NULL 확인 (Mock 04)
- [ ] Enrichment: lot_ends.recipe_id = 'Carsem_3X3' (Mock 09)
- [ ] Oracle 쿼리 ①: LOT별 INSPECTION_RESULT 일괄 조회 (`WHERE lot_id='LOT-20260122-001'` → 2,792건)
- [ ] Oracle 쿼리 ②: 레시피별 최근 3 LOT 평균 total_units (`WHERE recipe_id='Carsem_3X3' LIMIT 3` → ~2,792)
- [ ] Oracle 쿼리 ③: 레시피별 수율 시계열 EWMA 입력 (`WHERE recipe_id='Carsem_3X3' ORDER BY time DESC LIMIT 28`)
- [ ] Oracle 쿼리 ④: 장비별 알람 카운터 R26 (`WHERE hw_error_code='CAM_TIMEOUT_ERR' AND time > NOW()-'1 day'`)
- [ ] Oracle 쿼리 ⑤: AggregateException 카운터 R33 (`WHERE hw_error_code='VISION_SCORE_ERR' AND auto_recovery_attempted=false`)
- [ ] 4대 동시 시나리오 유입 → 적재 지연 없음

### 14.4 Git 커밋 메시지
```
test(historian): 통합 테스트 — Mock 27종 전수 적재 검증 (H10)

- PASS drop / FAIL 전체 / enrichment / 알람 / 감사 로그 / Oracle
- Oracle 연동 쿼리 5종 검증
- 4대 동시 유입 성능 확인
```

---

## 15. 작업 시 주의사항 (실수 방지)

### 15.1 자주 하는 실수
- ❌ PASS일 때 `inspection_detail`을 빈 객체 `{}`로 적재 → NULL이어야 함
- ❌ `inspection_detail` 내부를 snake_case로 변환 → `ZAxisNum`이 `z_axis_num`이 됨. PascalCase 유지 필수
- ❌ `fail_count`를 null로 설정 → PASS일 때 반드시 `0`
- ❌ mqtt.js 내장 `reconnectPeriod`에 의존 → 커스텀 백오프 `[1,2,5,15,30,60]` 구현 필수
- ❌ `Date.now()` 또는 로컬 시간으로 timestamp 생성 → 원본 메시지의 ISO 8601 UTC 그대로 적재
- ❌ ALARM_ACK 빈 페이로드를 HW_ALARM으로 적재 시도 → 라우터에서 선필터링
- ❌ LOT_END에 recipe_id 빠뜨림 → STATUS 캐시에서 enrichment 필수
- ❌ `client.publish()` 호출 → Historian은 Subscribe-only, ACL 위반
- ❌ JSON.parse 결과를 snake_case 변환 함수에 통째로 넘김 → `inspection_detail` 내부 PascalCase 파괴

### 15.2 도움이 되는 작업 패턴
- ✅ Task 시작 전에 관련 명세서 절을 `view`로 읽어 현재 상태 확인
- ✅ `mosquitto_sub -v -t "ds/#"` 로 Broker 메시지 실시간 모니터링
- ✅ JSON 파싱 결과를 `node -e "JSON.parse(...)"` 로 검증
- ✅ 각 Task 끝에 검증 체크리스트 모든 항목 점검 후 다음 Task로
- ✅ Git 커밋은 Task 단위로 11번 분리. 한 커밋에 여러 Task 섞지 말 것
- ✅ Mock 데이터 적재 후 `psql`에서 `SELECT` 쿼리로 즉시 확인

### 15.3 막혔을 때
- **스키마/적재 구조 불명확** → `./명세서/Historian_작업명세서.md` §4 스키마를 다시 읽는다
- **페이로드 구조 불명확** → `../DS-Document/EAP_mock_data/` 해당 번호 파일 직접 참조
- **QoS / Retain 불명확** → `../DS-Document/명세서/DS_EAP_MQTT_API_명세서.md` §1.1 토픽 표가 최종 기준
- **재연결 수치 불명확** → API 명세서 §부록 A.6 수치가 확정값. 임의 변경 금지
- **Oracle 쿼리 패턴** → `../DS-Document/문서/오라클 2차 검증 기획안.md` 참조
- **PASS drop 정책 세부** → `../EAP_VM/명세서/eap-spec-v1.md` §4.3 구독자별 정책표
- **두 가지 해석 가능** → **데이터 병목 방지** + **시계열 데이터 무결성** 두 원칙에 더 부합하는 쪽 선택
- **명세서에 없는 내용** → 추측으로 진행하지 않고 사용자에게 확인 요청

---

## 16. 절대 금지 사항

- ❌ INSPECTION_RESULT PASS일 때 detail 그룹 적재 금지 (PASS drop 정책 위반)
- ❌ `inspection_detail` 내부 PascalCase → snake_case 변환 금지 (GVisionWpf 원본 유지)
- ❌ Mock 데이터(01~17) 수치 변경 금지 (Carsem 14일 실측값)
- ❌ 재연결 백오프 수열 `[1, 2, 5, 15, 30, 60]` 임의 변경 금지
- ❌ `historian` 계정으로 MQTT Publish 시도 금지 (ACL 위반)
- ❌ `timestamp`에 `Date.now()` 또는 로컬 시간 사용 금지 — 원본 메시지의 ISO 8601 UTC 그대로 적재

---

## 17. Mock 데이터 참조 (27종)

| # | 파일 | 이벤트 | 대표 수치 | 적재 시 주의 |
|:---|:---|:---|:---|:---|
| 01 | heartbeat | HEARTBEAT | 3초 주기 | 경량 3필드 |
| 02 | status_run | STATUS_UPDATE | RUN / 1,247/2,792 unit | 캐시 갱신 필수 |
| 03 | status_idle | STATUS_UPDATE | IDLE / 2,792/2,792 unit | 진행률 null 허용 |
| 04 | inspection_pass | INSPECTION_RESULT | PASS / ET=1 | **PASS drop: detail NULL** |
| 05 | inspection_fail_side_et52 | INSPECTION_RESULT | FAIL / ET=52 8/8 | 전체 적재 |
| 06 | inspection_fail_side_et12 | INSPECTION_RESULT | FAIL / ET=12 8/8 | 전체 적재 |
| 07 | inspection_fail_prs_offset | INSPECTION_RESULT | FAIL / ET=11 3/8 | 전체 적재 |
| 08 | inspection_fail_side_mixed | INSPECTION_RESULT | FAIL / ET=52+12 혼재 | 전체 적재 |
| 09 | lot_end_normal | LOT_END | COMPLETED / 96.2% | **enrichment: recipe_id** |
| 10 | lot_end_aborted | LOT_END | ABORTED / 94.2% | enrichment: recipe_id |
| 11~17 | alarm_* | HW_ALARM | 7종 알람 | burst_id nullable |
| 18~20 | recipe_changed_* | RECIPE_CHANGED | 3종 레시피 전환 | equipment_status=IDLE |
| 21~22 | control_* | CONTROL_CMD | EMERGENCY_STOP / STATUS_QUERY | 감사 로그 |
| 23~25 | oracle_* | ORACLE_ANALYSIS | NORMAL / WARNING / DANGER | score nullable |
| 26~27 | control_alarm_ack_* | CONTROL_CMD | ALARM_ACK (단독/burst) | 감사 로그 |

### 17.1 실측 기준값 (Carsem 현장)

| 지표 | 실측값 |
|:---|:---|
| Heartbeat 주기 | 3초 |
| STATUS 주기 | 6초 |
| takt_time | ~1,620ms (MAP+PRS+SIDE 합산) |
| total_units/Lot | 2,792 (349 Strip × 8슬롯) |
| 정상 수율 | 96.2% (28 LOT 학습 기반) |
| Lot 소요시간 | 82분 (정상 40~180분, 최대 370분) |

---

## 18. 최종 확인

이 명세서를 받았다면, 작업을 시작하기 전에 아래 5가지를 너 자신에게 확인한다.

1. ✅ 11개 Task의 우선순위와 의존성을 이해했는가? (H1 → H2 → H3 → H4 → H5 → H6 → H11 → H7 → H8 → H9 → H10)
2. ✅ **TypeScript 코드를 작성**하는 것이 이번 작업의 목표라는 점을 이해했는가?
3. ✅ `./명세서/Historian_작업명세서.md`가 구현의 1차 설계도라는 점을 기억하는가?
4. ✅ 실로그 기반 Mock 01~17의 수치는 절대 변경하지 않는다는 원칙을 기억하는가?
5. ✅ 각 Task 끝에 검증 체크리스트를 모두 통과해야 다음 Task로 넘어간다는 규칙을 따를 것인가?

모두 ✅이면 **§0.4 필독 문서 5개를 먼저 read한 후**, Task H1부터 시작한다.

작업 진행 중 §0~§17 중 어느 절이라도 모순되거나 막막한 부분이 있다면, 추측으로 진행하지 말고 멈춰서 사용자에게 질문한다.

---

## 19. 최종 보고 형식

```
## Historian 서버 구현 완료 보고

### 변경 통계
- 신규 파일: N개
- 추가 라인: +X

### Task 완료 현황
- [x] H1 프로젝트 초기 설정 (P0)
- [x] H2 TimescaleDB 스키마 DDL (P0)
- [x] H3 MQTT 클라이언트 + 백오프 (P0)
- [x] H4 메시지 라우터 (P0)
- [x] H5 INSPECTION_RESULT PASS drop (P0)
- [x] H6 7종 이벤트 핸들러 (P1)
- [x] H11 STATUS 캐시 + enrichment (P0)
- [x] H7 배치 INSERT 최적화 (P1)
- [x] H8 Graceful Shutdown (P1)
- [x] H9 Continuous Aggregate (P2)
- [x] H10 통합 테스트 27종 (P1)

### 검증 결과
- PASS drop 정책: PASS
- Enrichment (recipe_id): PASS
- 재연결 백오프 수열: PASS
- 배치 INSERT 100건/1초: PASS
- Graceful Shutdown 순서: PASS
- Oracle 연동 쿼리 5종: PASS
- Mock 27종 전수 적재: PASS

### 다음 단계 권고
1. Oracle 서버 (Python) — Historian TSDB 경유 2차 검증
2. Dispatcher 서버 (Node.js) — read-only 조회 + 비식별화
3. 모바일 앱 (Flutter) — 실시간 N:1 타일 모니터링
```

---

**End of CLAUDE.md**
