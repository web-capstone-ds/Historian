# Historian 서버 작업명세서

**문서번호:** DS-HISTORIAN-SPEC-001 v1.0  
**작성일:** 2026-04-16  
**프로젝트:** 반도체 후공정 비전 검사 장비 — Historian 시계열 적재 서버  
**대외비**

| 항목 | 내용 |
| :--- | :--- |
| 장비 모델 | Genesem VELOCE-G7 Saw Singulation |
| 비전 소프트웨어 | GVisionWpf (C# WPF, HALCON + MQTTnet) |
| 현장 실측 기준 | Carsem Inc. / 2026-01-16~29 (14일) |
| 개발 언어 | TypeScript (Node.js) |
| 통신 프로토콜 | MQTT v5.0 (Eclipse Mosquitto 2.x) |
| DB | PostgreSQL + TimescaleDB |
| 네트워크 환경 | 망 분리 공장 현장 로컬 Wi-Fi |

---

## 1. 개요

### 1.1 목적

Historian 서버는 Broker에서 수신한 비전 검사 이벤트 데이터를 시계열 데이터베이스(TimescaleDB)에 적재하고 장기 보존하는 **읽기 전용 데이터 수집 서버**이다. Oracle 서버의 2차 검증(EWMA+MAD / Isolation Forest)과 AI 서버의 RAG 파이프라인에 필요한 원시 데이터를 공급하는 것이 핵심 역할이다.

### 1.2 시스템 내 위치

```
가상 EAP 서버 (C#, MQTTnet)
        │
        │  MQTT Publish (8종 이벤트, JSON)
        ▼
   Eclipse Mosquitto Broker (로컬 Wi-Fi)
        │
        ├──→ 모바일 앱 (Flutter)
        ├──→ Historian 서버 (본 프로젝트) ←── 너가 만드는 것
        │        │
        │        ├──→ Oracle 서버 (Python) ── TSDB 경유 일괄 조회
        │        └──→ Dispatcher 서버 (Node.js) ── read-only 조회 → AI 서버
        │
        ├──→ Oracle 서버 (Python) ── LOT_END 직접 구독 (트리거)
        └──→ MES 서버 (C#) ── 중앙 제어
```

### 1.3 데이터 흐름

```
[수신 경로 — Broker → Historian]
Broker → Historian MQTT Subscriber (ds/+/# 전체 구독)
  → JSON 파싱 → TimescaleDB INSERT

[공급 경로 — Historian → 소비자]
Oracle 서버 → Historian TSDB (SQL 직접 조회)
Dispatcher 서버 → Historian TSDB (read-only 조회 → AI 서버)
```

### 1.4 단일 책임 원칙

Historian은 **"저장"만** 수행한다. 판정(Oracle), 보안 전송(Dispatcher), 분석(AI)은 다른 서버의 책임이다. Historian에 장애가 발생해도 모바일 모니터링과 MES 제어는 독립적으로 유지된다.

---

## 2. 참조 문서

작업 시작 전 아래 문서를 반드시 참조한다.

| 우선순위 | 문서 | 참조 목적 |
| :--- | :--- | :--- |
| 1 | `명세서/DS_EAP_MQTT_API_명세서.md` v3.4 | 8종 이벤트 페이로드 필드 정의, QoS/Retained 정책, PASS drop 정책 |
| 2 | `명세서/eap-spec-v1.md` v1.0 | 이벤트 시퀀스, Mock 데이터 27종 인덱스, PASS drop 구독자별 정책표 |
| 3 | `명세서/DS_이벤트정의서.md` v1.0 | Rule 38개 판정 기준, Oracle 연동 인터페이스 |
| 4 | `문서/오라클 2차 검증 기획안.md` v1.0 | EWMA+MAD / Isolation Forest가 Historian에 요구하는 쿼리 패턴 |
| 5 | `문서/기획안.md` v1.0 | 7종 서버 구성, Dispatcher 연동 구조 |

> **문서 간 충돌 시:** API 명세서 v3.4 > eap-spec-v1 > 이벤트 정의서 v1.0

---

## 3. 기능 요구사항

### 3.1 MQTT 구독 (Subscribe)

Historian은 `ds/#` 와일드카드로 **8종 이벤트 전체**를 구독한다.

| 토픽 패턴 | 이벤트 | QoS | Retained | 적재 대상 |
| :--- | :--- | :--- | :--- | :--- |
| `ds/+/heartbeat` | HEARTBEAT | 1 | ❌ | ✅ 적재 (ONLINE/OFFLINE 이력) |
| `ds/+/status` | STATUS_UPDATE | 1 | ✅ | ✅ 적재 (장비 상태 시계열) |
| `ds/+/result` | INSPECTION_RESULT | 1 | ❌ | ✅ 조건부 적재 (§3.2 PASS drop 정책) |
| `ds/+/lot` | LOT_END | 2 | ✅ | ✅ 전체 적재 |
| `ds/+/alarm` | HW_ALARM | 2 | ✅ | ✅ 전체 적재 |
| `ds/+/recipe` | RECIPE_CHANGED | 2 | ✅ | ✅ 전체 적재 |
| `ds/+/control` | CONTROL_CMD | 2 | ❌ | ✅ 전체 적재 (감사 로그) |
| `ds/+/oracle` | ORACLE_ANALYSIS | 2 | ✅ | ✅ 전체 적재 |

#### ACL 계정 정책

| 항목 | 값 |
| :--- | :--- |
| 계정 | `historian` |
| Subscribe 허용 | `ds/#` (전체 읽기) |
| Publish 허용 | **없음** (읽기 전용) |

### 3.2 PASS drop 적재 정책 (핵심 병목 방지)

API 명세서 v3.4 §4 및 eap-spec-v1 §4.3의 **PASS drop 정책**을 Historian이 적재 시점에 적용한다.

> **규칙:** `overall_result = PASS AND fail_count = 0`이면, `inspection_detail` / `geometric` / `bga` / `surface` / `singulation` 그룹을 **적재하지 않는다**. `summary` 그룹 + `process` 그룹만 적재한다.

| 조건 | 적재 범위 | 예상 부하 감소 |
| :--- | :--- | :--- |
| PASS (fail_count = 0) | summary + process만 적재 | 적재 부하 ~60% 감소 |
| FAIL (fail_count ≥ 1) | 전체 필드 적재 | 전체 적재 |

**PASS 시 적재 필드 (summary + process):**

| 그룹 | 필드 |
| :--- | :--- |
| summary | `message_id`, `event_type`, `timestamp`, `equipment_id`, `equipment_status`, `lot_id`, `unit_id`, `strip_id`, `recipe_id`, `recipe_version`, `operator_id`, `overall_result`, `fail_reason_code`(null), `fail_count`(0), `total_inspected_count` |
| process | `inspection_duration_ms`, `takt_time_ms`, `algorithm_version` |

**FAIL 시 추가 적재 필드:**

| 그룹 | 필드 |
| :--- | :--- |
| inspection_detail | `prs_result[]` (PascalCase 유지), `side_result[]` (PascalCase 유지) |
| geometric | `dimension_w_mm`, `dimension_l_mm`, `dimension_h_mm`, `x_offset_um`, `y_offset_um`, `theta_deg`, `kerf_width_um` |
| bga | `available`, `ball_count_nominal`, `ball_count_actual`, `ball_diameter_avg_mm`, `coplanarity_mm`, `pitch_deviation_um`, `max_ball_offset_um`, `avg_ball_offset_um` |
| surface | `foreign_material_size_um`, `scratch_area_mm2`, `marking_quality_grade` |
| singulation | `chipping_top_um`, `chipping_bottom_um`, `burr_height_um` |

### 3.3 Oracle 서버 데이터 공급 인터페이스

Oracle 서버는 LOT_END를 직접 구독(트리거)하되, 해당 LOT의 INSPECTION_RESULT는 **Historian TSDB를 경유하여 일괄 조회**한다. 이는 Oracle 서버가 실시간 처리 부하에서 자유로워 복잡한 분석을 수행할 수 있도록 하기 위함이다.

**Oracle이 Historian에 요구하는 주요 쿼리 패턴:**

| 쿼리 | 용도 | 조건 |
| :--- | :--- | :--- |
| LOT별 INSPECTION_RESULT 일괄 조회 | 2차 검증 분석 원시 데이터 | `WHERE lot_id = ? AND equipment_id = ?` |
| 레시피별 최근 N LOT 수율 시계열 | EWMA+MAD 동적 임계값 계산 | `WHERE recipe_id = ? ORDER BY timestamp DESC LIMIT N` |
| 레시피별 LOT 3개 평균 total_units | STATUS_UPDATE expected_total_units 계산 | `WHERE recipe_id = ? ORDER BY timestamp DESC LIMIT 3` |
| 레시피별 ET 분포 통계 | Isolation Forest 특징 벡터 | `GROUP BY recipe_id, error_type` |
| 장비별 알람 이력 | R26/R33/R34 카운터 보조 | `WHERE equipment_id = ? AND event_type = 'HW_ALARM'` |

### 3.4 Dispatcher 서버 데이터 공급

Dispatcher는 Historian TSDB에 **read-only** 권한으로 접근하여, 배치 단위로 데이터를 조회한 후 비식별화 처리하여 Online Area의 AI 서버로 단방향 Push한다.

---

## 4. TimescaleDB 스키마 설계

### 4.1 설계 원칙

- **Hypertable**: `timestamp` 컬럼 기준 자동 파티셔닝 (TimescaleDB 핵심 기능)
- **JSON 저장**: detail 그룹은 `JSONB` 컬럼으로 유연하게 저장 (스키마 변경 최소화)
- **인덱스 전략**: 고빈도 쿼리 패턴 (equipment_id + lot_id, recipe_id + timestamp)에 복합 인덱스
- **Retention Policy**: TimescaleDB 자동 데이터 보존 정책 (heartbeat/status 90일, 나머지 365일)

### 4.2 테이블 구조

#### 4.2.1 `heartbeats` — HEARTBEAT 이벤트

```sql
CREATE TABLE heartbeats (
    time            TIMESTAMPTZ     NOT NULL,   -- timestamp (ISO 8601)
    message_id      UUID            NOT NULL,
    equipment_id    TEXT            NOT NULL
);

SELECT create_hypertable('heartbeats', 'time');
CREATE INDEX idx_heartbeats_eq ON heartbeats (equipment_id, time DESC);
```

#### 4.2.2 `status_updates` — STATUS_UPDATE 이벤트

```sql
CREATE TABLE status_updates (
    time                TIMESTAMPTZ     NOT NULL,
    message_id          UUID            NOT NULL,
    equipment_id        TEXT            NOT NULL,
    equipment_status    TEXT            NOT NULL,   -- RUN / IDLE / STOP
    lot_id              TEXT            NOT NULL,
    recipe_id           TEXT            NOT NULL,
    recipe_version      TEXT            NOT NULL,
    operator_id         TEXT            NOT NULL,
    uptime_sec          INTEGER         NOT NULL,
    current_unit_count  INTEGER,                    -- v3.4 진행률 (nullable)
    expected_total_units INTEGER,                   -- v3.4 진행률 (nullable)
    current_yield_pct   DOUBLE PRECISION            -- v3.4 진행률 (nullable)
);

SELECT create_hypertable('status_updates', 'time');
CREATE INDEX idx_status_eq_time ON status_updates (equipment_id, time DESC);
CREATE INDEX idx_status_eq_status ON status_updates (equipment_id, equipment_status);
```

#### 4.2.3 `inspection_results` — INSPECTION_RESULT 이벤트

```sql
CREATE TABLE inspection_results (
    time                    TIMESTAMPTZ         NOT NULL,
    message_id              UUID                NOT NULL,
    equipment_id            TEXT                NOT NULL,
    lot_id                  TEXT                NOT NULL,
    unit_id                 TEXT                NOT NULL,
    strip_id                TEXT                NOT NULL,
    recipe_id               TEXT                NOT NULL,
    recipe_version          TEXT                NOT NULL,
    operator_id             TEXT                NOT NULL,
    overall_result          TEXT                NOT NULL,   -- PASS / FAIL
    fail_reason_code        TEXT,                           -- nullable (PASS이면 null)
    fail_count              INTEGER             NOT NULL,
    total_inspected_count   INTEGER             NOT NULL,   -- 고정 = 8
    -- process 그룹 (PASS/FAIL 모두 적재)
    inspection_duration_ms  INTEGER             NOT NULL,
    takt_time_ms            INTEGER             NOT NULL,
    algorithm_version       TEXT                NOT NULL,
    -- detail 그룹 (FAIL일 때만 적재, PASS이면 NULL)
    inspection_detail       JSONB,              -- { prs_result[], side_result[] } PascalCase 유지
    geometric               JSONB,
    bga                     JSONB,
    surface                 JSONB,
    singulation             JSONB
);

SELECT create_hypertable('inspection_results', 'time');
CREATE INDEX idx_insp_eq_lot ON inspection_results (equipment_id, lot_id, time DESC);
CREATE INDEX idx_insp_recipe_time ON inspection_results (recipe_id, time DESC);
CREATE INDEX idx_insp_result ON inspection_results (overall_result, time DESC);
CREATE INDEX idx_insp_fail_reason ON inspection_results (fail_reason_code, time DESC)
    WHERE fail_reason_code IS NOT NULL;
```

#### 4.2.4 `lot_ends` — LOT_END 이벤트

```sql
CREATE TABLE lot_ends (
    time                TIMESTAMPTZ         NOT NULL,
    message_id          UUID                NOT NULL,
    equipment_id        TEXT                NOT NULL,
    lot_id              TEXT                NOT NULL,
    lot_status          TEXT                NOT NULL,   -- COMPLETED / ABORTED / ERROR
    recipe_id           TEXT                NOT NULL,   -- Enrichment: LOT_END 수신 시 마지막 STATUS_UPDATE에서 추출
    operator_id         TEXT                NOT NULL,   -- Enrichment: 동일 출처
    total_units         INTEGER             NOT NULL,
    pass_count          INTEGER             NOT NULL,
    fail_count          INTEGER             NOT NULL,
    yield_pct           DOUBLE PRECISION    NOT NULL,
    lot_duration_sec    INTEGER             NOT NULL
);

SELECT create_hypertable('lot_ends', 'time');
CREATE INDEX idx_lot_eq_time ON lot_ends (equipment_id, time DESC);
CREATE INDEX idx_lot_recipe_time ON lot_ends (recipe_id, time DESC);  -- Oracle EWMA 핵심 쿼리
CREATE INDEX idx_lot_id ON lot_ends (lot_id);
CREATE INDEX idx_lot_yield ON lot_ends (yield_pct, time DESC);
```

> **`recipe_id` Enrichment 전략:** LOT_END 페이로드에는 `recipe_id`가 포함되어 있지 않다 (API 명세서 §5.1). Historian은 장비별로 마지막 STATUS_UPDATE의 `recipe_id`를 인메모리 캐시에 유지하고, LOT_END 수신 시 해당 `equipment_id`의 캐시 값을 주입한다. 동일하게 `operator_id`도 캐시에서 추출한다. 이 enrichment는 Oracle 서버의 **레시피별 수율 시계열 쿼리**(`WHERE recipe_id = ? ORDER BY time DESC`)를 3-way JOIN 없이 단일 테이블 쿼리로 해결하기 위해 필수적이다.

#### 4.2.5 `hw_alarms` — HW_ALARM 이벤트

```sql
CREATE TABLE hw_alarms (
    time                        TIMESTAMPTZ     NOT NULL,
    message_id                  UUID            NOT NULL,
    equipment_id                TEXT            NOT NULL,
    equipment_status            TEXT            NOT NULL,   -- RUN / STOP
    alarm_level                 TEXT            NOT NULL,   -- CRITICAL / WARNING / INFO (API §6.1 필드명)
    hw_error_code               TEXT            NOT NULL,
    hw_error_source             TEXT            NOT NULL,   -- CAMERA / LIGHTING / VISION / PROCESS / MOTION / COOLANT
    hw_error_detail             TEXT            NOT NULL,
    exception_detail            JSONB,                      -- { module, exception_type, stack_trace_hash } nullable
    auto_recovery_attempted     BOOLEAN         NOT NULL,   -- Oracle R26/R33/R34 카운터 쿼리에 필수
    requires_manual_intervention BOOLEAN        NOT NULL,   -- 모바일 알림 강조 여부
    burst_id                    UUID,                       -- 알람 폭주 그룹 ID (단독이면 null)
    burst_count                 INTEGER,                    -- burst_id 그룹 내 누적 횟수 (단독이면 1)
    lot_id                      TEXT,                       -- 진행 중 LOT ID (nullable)
    payload_raw                 JSONB           NOT NULL    -- 원본 전체 보존
);

SELECT create_hypertable('hw_alarms', 'time');
CREATE INDEX idx_alarm_eq_time ON hw_alarms (equipment_id, time DESC);
CREATE INDEX idx_alarm_level ON hw_alarms (alarm_level, time DESC);
CREATE INDEX idx_alarm_error_code ON hw_alarms (hw_error_code, time DESC);
CREATE INDEX idx_alarm_burst ON hw_alarms (burst_id, time DESC) WHERE burst_id IS NOT NULL;
CREATE INDEX idx_alarm_recovery ON hw_alarms (hw_error_code, auto_recovery_attempted, time DESC);
```

#### 4.2.6 `recipe_changes` — RECIPE_CHANGED 이벤트

```sql
CREATE TABLE recipe_changes (
    time                    TIMESTAMPTZ     NOT NULL,
    message_id              UUID            NOT NULL,
    equipment_id            TEXT            NOT NULL,
    equipment_status        TEXT            NOT NULL,   -- 항상 IDLE (비정상 전환 감지용)
    previous_recipe_id      TEXT            NOT NULL,
    previous_recipe_version TEXT            NOT NULL,
    new_recipe_id           TEXT            NOT NULL,
    new_recipe_version      TEXT            NOT NULL,
    changed_by              TEXT            NOT NULL
);

SELECT create_hypertable('recipe_changes', 'time');
CREATE INDEX idx_recipe_eq_time ON recipe_changes (equipment_id, time DESC);
CREATE INDEX idx_recipe_new ON recipe_changes (new_recipe_id, time DESC);
```

#### 4.2.7 `control_commands` — CONTROL_CMD 이벤트 (감사 로그)

```sql
CREATE TABLE control_commands (
    time                TIMESTAMPTZ     NOT NULL,
    message_id          UUID            NOT NULL,
    equipment_id        TEXT            NOT NULL,   -- 토픽에서 추출
    command             TEXT            NOT NULL,
    issued_by           TEXT            NOT NULL,
    reason              TEXT,
    target_lot_id       TEXT,
    target_burst_id     UUID
);

SELECT create_hypertable('control_commands', 'time');
CREATE INDEX idx_ctrl_eq_time ON control_commands (equipment_id, time DESC);
CREATE INDEX idx_ctrl_command ON control_commands (command, time DESC);
```

#### 4.2.8 `oracle_analyses` — ORACLE_ANALYSIS 이벤트

```sql
CREATE TABLE oracle_analyses (
    time                TIMESTAMPTZ         NOT NULL,
    message_id          UUID                NOT NULL,
    equipment_id        TEXT                NOT NULL,
    lot_id              TEXT                NOT NULL,
    recipe_id           TEXT                NOT NULL,
    judgment            TEXT                NOT NULL,   -- NORMAL / WARNING / DANGER
    yield_actual        DOUBLE PRECISION    NOT NULL,
    yield_status        JSONB               NOT NULL,   -- dynamic_threshold 포함
    isolation_forest_score DOUBLE PRECISION,
    ai_comment          TEXT                NOT NULL,
    threshold_proposal  JSONB                           -- nullable
);

SELECT create_hypertable('oracle_analyses', 'time');
CREATE INDEX idx_oracle_eq_time ON oracle_analyses (equipment_id, time DESC);
CREATE INDEX idx_oracle_judgment ON oracle_analyses (judgment, time DESC);
CREATE INDEX idx_oracle_recipe ON oracle_analyses (recipe_id, time DESC);
```

### 4.3 TimescaleDB 보존 정책

```sql
-- 보존 정책 (운영 환경에서 조정 가능)
-- EWMA+MAD(LOT 5개↑) / Isolation Forest(LOT 10개↑) 학습 기간 보장을 위해
-- 신규 레시피가 10 LOT 축적까지 3개월 이상 소요될 수 있으므로 inspection_results도 1년 보존
SELECT add_retention_policy('heartbeats', INTERVAL '90 days');       -- 경량 데이터, 90일 충분
SELECT add_retention_policy('status_updates', INTERVAL '90 days');   -- 경량 데이터, 90일 충분
SELECT add_retention_policy('inspection_results', INTERVAL '365 days'); -- Oracle 학습 데이터 보존
SELECT add_retention_policy('lot_ends', INTERVAL '365 days');        -- LOT 데이터 1년 보존
SELECT add_retention_policy('hw_alarms', INTERVAL '365 days');       -- 알람 이력 1년 보존
SELECT add_retention_policy('recipe_changes', INTERVAL '365 days');  -- 레시피 이력 1년 보존
SELECT add_retention_policy('control_commands', INTERVAL '365 days');-- 감사 로그 1년 보존
SELECT add_retention_policy('oracle_analyses', INTERVAL '365 days'); -- Oracle 이력 1년 보존
```

### 4.4 Continuous Aggregate (선택적 최적화)

Oracle 서버의 빈번한 레시피별 수율 쿼리를 가속화하기 위한 사전 집계 뷰이다.

```sql
CREATE MATERIALIZED VIEW lot_yield_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    equipment_id,
    recipe_id,
    COUNT(*)                    AS lot_count,
    AVG(yield_pct)              AS avg_yield,
    MIN(yield_pct)              AS min_yield,
    MAX(yield_pct)              AS max_yield,
    AVG(lot_duration_sec)       AS avg_duration
FROM lot_ends
WHERE lot_status = 'COMPLETED'
GROUP BY bucket, equipment_id, recipe_id;

SELECT add_continuous_aggregate_policy('lot_yield_hourly',
    start_offset    => INTERVAL '2 hours',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
```

---

## 5. MQTT 클라이언트 구현 명세

### 5.1 연결 파라미터

| 항목 | 값 | 근거 |
| :--- | :--- | :--- |
| protocol_version | MQTT v5.0 | session_expiry_interval 사용 |
| client_id | `ds_historian_001` | 고정 (단일 인스턴스) |
| clean_start | **false** | 재연결 시 큐된 QoS 1/2 메시지 보존 |
| session_expiry_interval | **3600s** | 1시간 재연결 여유 |
| keep_alive | **60s** | EAP 기준과 동일 |
| 계정 | `historian` | ACL: Subscribe `ds/#` / Publish 없음 |

### 5.2 구독 토픽

```typescript
const SUBSCRIPTIONS: { topic: string; qos: 0 | 1 | 2 }[] = [
  { topic: 'ds/+/heartbeat', qos: 1 },
  { topic: 'ds/+/status',    qos: 1 },
  { topic: 'ds/+/result',    qos: 1 },
  { topic: 'ds/+/lot',       qos: 2 },
  { topic: 'ds/+/alarm',     qos: 2 },
  { topic: 'ds/+/recipe',    qos: 2 },
  { topic: 'ds/+/control',   qos: 2 },
  { topic: 'ds/+/oracle',    qos: 2 },
];
```

### 5.3 재연결 백오프 (API 명세서 §부록 A.6 준수)

```typescript
const BACKOFF_SECONDS = [1, 2, 5, 15, 30, 60]; // 변경 금지 — 명세서 확정값

function getBackoffDelay(attempt: number): number {
  const baseSec = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
  const jitter = baseSec * (0.8 + Math.random() * 0.4); // ±20%
  return jitter * 1000; // ms
}
```

### 5.4 메시지 라우팅

토픽 패턴에서 `event_type`을 추출하여 해당 적재 핸들러로 라우팅한다.

```typescript
// 토픽 파싱: ds/{equipment_id}/{segment}
function parseTopicSegment(topic: string): { equipmentId: string; segment: string } {
  const parts = topic.split('/');
  // parts[0] = 'ds', parts[1] = equipment_id, parts[2] = segment
  return { equipmentId: parts[1], segment: parts[2] };
}

// 라우팅 테이블
const HANDLERS: Record<string, (equipmentId: string, payload: Buffer) => Promise<void>> = {
  heartbeat:  handleHeartbeat,
  status:     handleStatusUpdate,
  result:     handleInspectionResult,  // PASS drop 정책 적용
  lot:        handleLotEnd,
  alarm:      handleHwAlarm,
  recipe:     handleRecipeChanged,
  control:    handleControlCmd,
  oracle:     handleOracleAnalysis,
};
```

### 5.5 빈 페이로드 처리 (Retained Clear)

HW_ALARM의 ALARM_ACK 메커니즘으로 인해 `ds/+/alarm` 토픽에 **빈 페이로드**가 수신될 수 있다. 이는 retained 메시지 클리어 신호이므로 적재하지 않고 무시한다.

```typescript
function onMessage(topic: string, payload: Buffer): void {
  if (payload.length === 0) {
    // Retained clear 신호 — 적재 스킵
    logger.debug(`Empty payload on ${topic}, skipping (retained clear)`);
    return;
  }
  // ... 정상 라우팅
}
```

---

## 6. 적재 핸들러 상세

### 6.1 HEARTBEAT 핸들러

```typescript
async function handleHeartbeat(equipmentId: string, payload: Buffer): Promise<void> {
  const msg = JSON.parse(payload.toString());
  await pool.query(
    `INSERT INTO heartbeats (time, message_id, equipment_id)
     VALUES ($1, $2, $3)`,
    [msg.timestamp, msg.message_id, msg.equipment_id]
  );
}
```

### 6.2 INSPECTION_RESULT 핸들러 (PASS drop 핵심)

```typescript
async function handleInspectionResult(equipmentId: string, payload: Buffer): Promise<void> {
  const msg = JSON.parse(payload.toString());

  const isPass = msg.overall_result === 'PASS' && msg.fail_count === 0;

  await pool.query(
    `INSERT INTO inspection_results (
       time, message_id, equipment_id, lot_id, unit_id, strip_id,
       recipe_id, recipe_version, operator_id,
       overall_result, fail_reason_code, fail_count, total_inspected_count,
       inspection_duration_ms, takt_time_ms, algorithm_version,
       inspection_detail, geometric, bga, surface, singulation
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      msg.timestamp,
      msg.message_id,
      msg.equipment_id,
      msg.lot_id,
      msg.unit_id,
      msg.strip_id,
      msg.recipe_id,
      msg.recipe_version,
      msg.operator_id,
      msg.overall_result,
      msg.fail_reason_code ?? null,
      msg.fail_count,
      msg.total_inspected_count,
      msg.process.inspection_duration_ms,
      msg.process.takt_time_ms,
      msg.process.algorithm_version,
      // PASS drop 정책: PASS이면 detail 그룹 NULL 적재
      isPass ? null : JSON.stringify(msg.inspection_detail),
      isPass ? null : JSON.stringify(msg.geometric),
      isPass ? null : JSON.stringify(msg.bga),
      isPass ? null : JSON.stringify(msg.surface),
      isPass ? null : JSON.stringify(msg.singulation),
    ]
  );
}
```

### 6.3 LOT_END 핸들러

```typescript
// 장비별 마지막 STATUS_UPDATE 캐시 (recipe_id / operator_id enrichment용)
const equipmentStatusCache = new Map<string, { recipeId: string; operatorId: string }>();

// STATUS_UPDATE 수신 시 캐시 갱신 (handleStatusUpdate 내부에서 호출)
function updateEquipmentCache(equipmentId: string, recipeId: string, operatorId: string): void {
  equipmentStatusCache.set(equipmentId, { recipeId, operatorId });
}

async function handleLotEnd(equipmentId: string, payload: Buffer): Promise<void> {
  const msg = JSON.parse(payload.toString());

  // LOT_END 페이로드에 recipe_id가 없으므로 STATUS_UPDATE 캐시에서 enrichment
  const cached = equipmentStatusCache.get(msg.equipment_id);
  const recipeId = cached?.recipeId ?? 'UNKNOWN';
  const operatorId = cached?.operatorId ?? 'UNKNOWN';

  if (!cached) {
    logger.warn(`No STATUS_UPDATE cache for ${msg.equipment_id}, recipe_id set to UNKNOWN`);
  }

  await pool.query(
    `INSERT INTO lot_ends (
       time, message_id, equipment_id, lot_id, lot_status,
       recipe_id, operator_id,
       total_units, pass_count, fail_count, yield_pct, lot_duration_sec
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      msg.timestamp, msg.message_id, msg.equipment_id,
      msg.lot_id, msg.lot_status,
      recipeId, operatorId,
      msg.total_units, msg.pass_count, msg.fail_count,
      msg.yield_pct, msg.lot_duration_sec,
    ]
  );
}
```

### 6.4 HW_ALARM 핸들러

```typescript
async function handleHwAlarm(equipmentId: string, payload: Buffer): Promise<void> {
  const msg = JSON.parse(payload.toString());
  await pool.query(
    `INSERT INTO hw_alarms (
       time, message_id, equipment_id, equipment_status,
       alarm_level, hw_error_code, hw_error_source, hw_error_detail,
       exception_detail, auto_recovery_attempted, requires_manual_intervention,
       burst_id, burst_count, lot_id, payload_raw
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      msg.timestamp, msg.message_id, msg.equipment_id,
      msg.equipment_status,
      msg.alarm_level, msg.hw_error_code,
      msg.hw_error_source, msg.hw_error_detail,
      msg.exception_detail ? JSON.stringify(msg.exception_detail) : null,
      msg.auto_recovery_attempted,
      msg.requires_manual_intervention,
      msg.burst_id ?? null,
      msg.burst_count ?? null,
      msg.lot_id ?? null,
      JSON.stringify(msg),  // 원본 전체 보존
    ]
  );
}
```

---

## 7. 부하 산정 및 성능 최적화

### 7.1 메시지 유입량 산정 (N=4대 장비 기준)

| 이벤트 | 주기 | 장비당 | 4대 합산 | 페이로드 |
| :--- | :--- | :--- | :--- | :--- |
| HEARTBEAT | 3초 | 20건/분 | 80건/분 | ~150B |
| STATUS_UPDATE | 6초 | 10건/분 | 40건/분 | ~400B |
| INSPECTION_RESULT | 1,620ms | ~37건/분 | ~148건/분 | ~2.1KB |
| LOT_END | LOT 완료 1회 | ~0.7건/시 | ~2.8건/시 | ~300B |
| HW_ALARM | 이벤트 발생 | 불규칙 | 불규칙 | ~500B |
| RECIPE_CHANGED | 변경 시 | 불규칙 | 불규칙 | ~300B |
| CONTROL_CMD | 명령 시 | 불규칙 | 불규칙 | ~250B |
| ORACLE_ANALYSIS | LOT 후 비동기 | ~0.7건/시 | ~2.8건/시 | ~500B |

**피크 유입량:** INSPECTION_RESULT가 지배적. 4대 동시 RUN 시 약 **148건/분 (~2.5건/초)**, 페이로드 합산 약 **310KB/분**.

### 7.2 적재 최적화 전략

#### 7.2.1 배치 INSERT

INSPECTION_RESULT의 높은 유입 빈도를 고려하여, 개별 INSERT 대신 **배치 INSERT**를 사용한다.

```typescript
// 버퍼링 후 일괄 INSERT (100건 또는 1초 주기 중 먼저 도달 시 플러시)
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;

class BatchInserter {
  private buffer: InspectionRow[] = [];
  private timer: NodeJS.Timeout;

  constructor(private pool: Pool) {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  async add(row: InspectionRow): Promise<void> {
    this.buffer.push(row);
    if (this.buffer.length >= BATCH_SIZE) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    // pg COPY 또는 multi-row INSERT
    await this.bulkInsert(batch);
  }
}
```

#### 7.2.2 커넥션 풀링

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.TSDB_HOST ?? 'localhost',
  port: parseInt(process.env.TSDB_PORT ?? '5432'),
  database: process.env.TSDB_DATABASE ?? 'ds_historian',
  user: process.env.TSDB_USER ?? 'historian',
  password: process.env.TSDB_PASSWORD,
  max: 10,                  // 최대 커넥션 수
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

---

## 8. 프로젝트 구조

```
historian/
├── src/
│   ├── index.ts                    # 엔트리포인트, Graceful Shutdown
│   ├── config/
│   │   └── env.ts                  # 환경변수 로딩 (.env)
│   ├── mqtt/
│   │   ├── client.ts               # MQTT 클라이언트 (재연결 백오프)
│   │   ├── router.ts               # 토픽 → 핸들러 라우팅
│   │   └── subscriptions.ts        # 구독 토픽 + QoS 정의
│   ├── handlers/
│   │   ├── heartbeat.handler.ts
│   │   ├── status.handler.ts
│   │   ├── inspection.handler.ts   # PASS drop 정책 구현
│   │   ├── lot-end.handler.ts      # recipe_id enrichment (STATUS 캐시 참조)
│   │   ├── alarm.handler.ts
│   │   ├── recipe.handler.ts
│   │   ├── control.handler.ts
│   │   └── oracle.handler.ts
│   ├── db/
│   │   ├── pool.ts                 # pg Pool 초기화
│   │   ├── schema.sql              # DDL (Hypertable + 인덱스)
│   │   └── batch-inserter.ts       # 배치 INSERT 유틸
│   └── utils/
│       ├── logger.ts               # 구조적 로깅 (pino)
│       ├── backoff.ts              # 재연결 백오프 유틸
│       └── equipment-cache.ts      # 장비별 STATUS 캐시 (recipe_id/operator_id enrichment)
├── test/
│   ├── handlers/
│   │   └── inspection.handler.test.ts  # PASS drop 정책 단위 테스트
│   └── mqtt/
│       └── client.test.ts              # 재연결 백오프 단위 테스트
├── docker-compose.yml              # TimescaleDB + Historian 로컬 개발 환경
├── .env.example
├── tsconfig.json
├── package.json
└── README.md
```

---

## 9. Graceful Shutdown

SIGTERM 수신 시 안전하게 종료한다.

```typescript
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, starting graceful shutdown...`);

  // 1. 배치 버퍼 플러시 (잔여 데이터 적재)
  await batchInserter.flush();
  logger.info('Batch buffer flushed');

  // 2. MQTT 연결 해제
  await mqttClient.end(true);  // force=true, 5초 타임아웃
  logger.info('MQTT disconnected');

  // 3. DB 커넥션 풀 해제
  await pool.end();
  logger.info('DB pool closed');

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

---

## 10. 환경변수

```bash
# .env.example
# MQTT
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=historian
MQTT_PASSWORD=                          # broker/.env 참조
MQTT_CLIENT_ID=ds_historian_001

# TimescaleDB
TSDB_HOST=localhost
TSDB_PORT=5432
TSDB_DATABASE=ds_historian
TSDB_USER=historian
TSDB_PASSWORD=

# 적재
BATCH_SIZE=100                          # 배치 INSERT 크기
FLUSH_INTERVAL_MS=1000                  # 배치 플러시 주기 (ms)

# 로깅
LOG_LEVEL=info                          # debug | info | warn | error
```

---

## 11. Docker Compose (로컬 개발)

```yaml
version: '3.8'

services:
  timescaledb:
    image: timescale/timescaledb:latest-pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: ds_historian
      POSTGRES_USER: historian
      POSTGRES_PASSWORD: ${TSDB_PASSWORD}
    volumes:
      - tsdb_data:/var/lib/postgresql/data
      - ./src/db/schema.sql:/docker-entrypoint-initdb.d/01_schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U historian -d ds_historian"]
      interval: 5s
      timeout: 5s
      retries: 5

  historian:
    build: .
    depends_on:
      timescaledb:
        condition: service_healthy
    env_file: .env
    environment:
      TSDB_HOST: timescaledb
      MQTT_BROKER_URL: mqtt://broker:1883
    restart: unless-stopped

volumes:
  tsdb_data:
```

---

## 12. 검증 체크리스트

### 12.1 MQTT 정책 준수

| 항목 | 기준 | 확인 |
| :--- | :--- | :--- |
| 구독 QoS | heartbeat/status/result → QoS 1, 나머지 → QoS 2 | ☐ |
| clean_start | `false` (재연결 시 큐 보존) | ☐ |
| 재연결 백오프 | `[1, 2, 5, 15, 30, 60]`, jitter ±20% | ☐ |
| ACL 계정 | `historian` (Subscribe only, Publish 없음) | ☐ |
| 빈 페이로드 처리 | ALARM_ACK retained clear 신호 무시 | ☐ |

### 12.2 PASS drop 정책 준수

| 항목 | 기준 | 확인 |
| :--- | :--- | :--- |
| PASS 판정 | `overall_result=PASS AND fail_count=0` → detail NULL 적재 | ☐ |
| PASS 적재 범위 | summary + process 그룹만 | ☐ |
| FAIL 적재 범위 | 전체 필드 (inspection_detail, geometric, bga, surface, singulation 포함) | ☐ |
| PascalCase 유지 | inspection_detail 내부 필드 PascalCase → JSONB 그대로 저장 | ☐ |

### 12.3 데이터 정합성

| 항목 | 기준 | 확인 |
| :--- | :--- | :--- |
| timestamp 파싱 | ISO 8601 UTC 밀리초 (.fffZ) → TIMESTAMPTZ 정상 변환 | ☐ |
| message_id | UUID v4 형식 검증 | ☐ |
| Mock 04 (PASS) 적재 | detail 컬럼 전부 NULL, process 컬럼 정상 | ☐ |
| Mock 05 (FAIL ET=52) 적재 | 전체 컬럼 정상 적재, singulation 값 일치 | ☐ |
| Mock 09 (LOT_END) 적재 | yield_pct=96.2, total_units=2792, recipe_id=Carsem_3X3 (enrichment) | ☐ |
| Mock 11 (HW_ALARM) 적재 | alarm_level=CRITICAL, hw_error_source=CAMERA, auto_recovery_attempted=false | ☐ |
| Mock 16 (HW_ALARM burst) 적재 | 시나리오 러너 경유 시 burst_id NOT NULL, burst_count=41. Mock JSON 직접 적재 시 burst_id=NULL 정상 | ☐ |
| Mock 18 (RECIPE_CHANGED) 적재 | equipment_status=IDLE 정상 적재 | ☐ |

### 12.4 Enrichment 검증

| 항목 | 기준 | 확인 |
| :--- | :--- | :--- |
| STATUS_UPDATE 캐시 | 장비별 recipe_id/operator_id 인메모리 캐시 정상 갱신 | ☐ |
| LOT_END recipe_id | STATUS_UPDATE 캐시에서 추출하여 lot_ends.recipe_id 적재 | ☐ |
| 캐시 미존재 시 | recipe_id='UNKNOWN' 적재 + WARN 로그 출력 | ☐ |

### 12.5 Oracle 연동 쿼리 검증

| 쿼리 | 기대 결과 | 확인 |
| :--- | :--- | :--- |
| LOT별 INSPECTION_RESULT 조회 | `WHERE lot_id='LOT-20260122-001'` → 2,792건 | ☐ |
| 레시피별 최근 3 LOT 평균 | `SELECT AVG(total_units) FROM lot_ends WHERE recipe_id='Carsem_3X3' ORDER BY time DESC LIMIT 3` → ~2,792 | ☐ |
| 레시피별 수율 시계열 (EWMA 입력) | `SELECT yield_pct FROM lot_ends WHERE recipe_id='Carsem_3X3' ORDER BY time DESC LIMIT 28` | ☐ |
| 장비별 알람 카운터 (R26) | `SELECT COUNT(*) FROM hw_alarms WHERE equipment_id=? AND hw_error_code='CAM_TIMEOUT_ERR' AND time > NOW()-'1 day'` | ☐ |
| AggregateException 카운터 (R33) | `SELECT COUNT(*) FROM hw_alarms WHERE hw_error_code='VISION_SCORE_ERR' AND auto_recovery_attempted=false AND time > NOW()-'1 day'` | ☐ |

### 12.6 성능 검증

| 항목 | 기준 | 확인 |
| :--- | :--- | :--- |
| 4대 동시 유입 | ~2.5건/초 INSPECTION_RESULT 적재 지연 없음 | ☐ |
| 배치 INSERT | 100건 또는 1초 주기 정상 플러시 | ☐ |
| Graceful Shutdown | SIGTERM → 배치 플러시 → MQTT 해제 → DB 해제 순서 | ☐ |

---

## 13. Task 분류 및 우선순위

| Task | 설명 | 우선순위 | 의존성 |
| :--- | :--- | :--- | :--- |
| H1 | 프로젝트 초기 설정 (TypeScript, ESLint, tsconfig, package.json) | P0 | 없음 |
| H2 | TimescaleDB 스키마 DDL + Docker Compose | P0 | 없음 |
| H3 | MQTT 클라이언트 (재연결 백오프 + 구독) | P0 | Broker 기동 |
| H4 | 메시지 라우터 (토픽 → 핸들러 매핑) | P0 | H3 |
| H5 | INSPECTION_RESULT 핸들러 (PASS drop 정책) | P0 | H2, H4 |
| H6 | 나머지 7종 이벤트 핸들러 | P1 | H2, H4 |
| H7 | 배치 INSERT 최적화 | P1 | H5 |
| H8 | Graceful Shutdown | P1 | H3, H7 |
| H9 | Continuous Aggregate (수율 사전 집계) | P2 | H2, H6 |
| H10 | 통합 테스트 (Mock 데이터 27종 전수 적재 검증) | P1 | H5, H6, H11 |
| H11 | 장비별 STATUS 캐시 + LOT_END recipe_id enrichment | P0 | H4, H6 |

---

## 14. 절대 금지 사항

- ❌ INSPECTION_RESULT PASS일 때 detail 그룹 적재 금지 (PASS drop 정책 위반)
- ❌ `inspection_detail` 내부 PascalCase → snake_case 변환 금지 (GVisionWpf 원본 유지)
- ❌ Mock 데이터(01~17) 수치 변경 금지 (Carsem 14일 실측값)
- ❌ 재연결 백오프 수열 `[1, 2, 5, 15, 30, 60]` 임의 변경 금지
- ❌ `historian` 계정으로 MQTT Publish 시도 금지 (ACL 위반)
- ❌ `timestamp`에 `Date.now()` 또는 로컬 시간 사용 금지 — 원본 메시지의 ISO 8601 UTC 그대로 적재
- ❌ 8종 토픽 패턴 구조 (`ds/{eq}/heartbeat` 등) 변경 금지

---

## 15. 막혔을 때

- **페이로드 구조 불명확** → `EAP_mock_data/` 해당 번호 파일 직접 참조
- **QoS / Retain 불명확** → `명세서/DS_EAP_MQTT_API_명세서.md` §1.1 토픽 표가 최종 기준
- **재연결 수치 불명확** → §부록 A.6 수치가 확정값. 임의 변경 금지
- **Oracle 쿼리 패턴** → `문서/오라클 2차 검증 기획안.md` §4-3 아키텍처 참조
- **두 가지 해석 가능** → **데이터 병목 방지** + **현장 엔지니어 즉시성** 두 원칙에 더 부합하는 쪽 선택
- **명세서에 없는 내용** → 추측으로 진행하지 않고 사용자에게 확인 요청

---

**End of Historian_작업명세서.md**
