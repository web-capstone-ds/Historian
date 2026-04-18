-- ─────────────────────────────────────────────────────────
-- DS Historian TimescaleDB 스키마 (작업명세서 §4)
-- 멱등성: 모든 DDL은 재실행 안전 (IF NOT EXISTS / if_not_exists => TRUE)
-- ─────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─────────────────────────────────────────────────────────
-- §4.2.1 heartbeats — HEARTBEAT
-- ─────────────────────────────────────────────────────────
-- message_id는 TEXT — 합성 Mock(21/22/24/25/26/27) message_id가 hex 외 문자를 포함하여 UUID 타입 거부
-- 실측 EAP는 Guid.NewGuid() v4를 발행하므로 TEXT로도 호환
CREATE TABLE IF NOT EXISTS heartbeats (
    time            TIMESTAMPTZ     NOT NULL,
    message_id      TEXT            NOT NULL,
    equipment_id    TEXT            NOT NULL
);

SELECT create_hypertable('heartbeats', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_heartbeats_eq
    ON heartbeats (equipment_id, time DESC);

-- ─────────────────────────────────────────────────────────
-- §4.2.2 status_updates — STATUS_UPDATE
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS status_updates (
    time                    TIMESTAMPTZ     NOT NULL,
    message_id              TEXT            NOT NULL,
    equipment_id            TEXT            NOT NULL,
    equipment_status        TEXT            NOT NULL,
    lot_id                  TEXT            NOT NULL,
    recipe_id               TEXT            NOT NULL,
    recipe_version          TEXT            NOT NULL,
    operator_id             TEXT            NOT NULL,
    uptime_sec              INTEGER         NOT NULL,
    current_unit_count      INTEGER,
    expected_total_units    INTEGER,
    current_yield_pct       DOUBLE PRECISION
);

SELECT create_hypertable('status_updates', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_status_eq_time
    ON status_updates (equipment_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_status_eq_status
    ON status_updates (equipment_id, equipment_status);

-- ─────────────────────────────────────────────────────────
-- §4.2.3 inspection_results — INSPECTION_RESULT
-- PASS drop: PASS이면 inspection_detail/geometric/bga/surface/singulation NULL
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inspection_results (
    time                    TIMESTAMPTZ         NOT NULL,
    message_id              TEXT                NOT NULL,
    equipment_id            TEXT                NOT NULL,
    lot_id                  TEXT                NOT NULL,
    unit_id                 TEXT                NOT NULL,
    strip_id                TEXT                NOT NULL,
    recipe_id               TEXT                NOT NULL,
    recipe_version          TEXT                NOT NULL,
    operator_id             TEXT                NOT NULL,
    overall_result          TEXT                NOT NULL,
    fail_reason_code        TEXT,
    fail_count              INTEGER             NOT NULL,
    total_inspected_count   INTEGER             NOT NULL,
    inspection_duration_ms  INTEGER             NOT NULL,
    takt_time_ms            INTEGER             NOT NULL,
    algorithm_version       TEXT                NOT NULL,
    inspection_detail       JSONB,
    geometric               JSONB,
    bga                     JSONB,
    surface                 JSONB,
    singulation             JSONB
);

SELECT create_hypertable('inspection_results', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_insp_eq_lot
    ON inspection_results (equipment_id, lot_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_insp_recipe_time
    ON inspection_results (recipe_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_insp_result
    ON inspection_results (overall_result, time DESC);
CREATE INDEX IF NOT EXISTS idx_insp_fail_reason
    ON inspection_results (fail_reason_code, time DESC)
    WHERE fail_reason_code IS NOT NULL;

-- ─────────────────────────────────────────────────────────
-- §4.2.4 lot_ends — LOT_END
-- recipe_id / operator_id는 STATUS 캐시 enrichment (H11)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lot_ends (
    time                TIMESTAMPTZ         NOT NULL,
    message_id          TEXT                NOT NULL,
    equipment_id        TEXT                NOT NULL,
    lot_id              TEXT                NOT NULL,
    lot_status          TEXT                NOT NULL,
    recipe_id           TEXT                NOT NULL,
    operator_id         TEXT                NOT NULL,
    total_units         INTEGER             NOT NULL,
    pass_count          INTEGER             NOT NULL,
    fail_count          INTEGER             NOT NULL,
    yield_pct           DOUBLE PRECISION    NOT NULL,
    lot_duration_sec    INTEGER             NOT NULL
);

SELECT create_hypertable('lot_ends', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_lot_eq_time
    ON lot_ends (equipment_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_lot_recipe_time
    ON lot_ends (recipe_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_lot_id
    ON lot_ends (lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_yield
    ON lot_ends (yield_pct, time DESC);

-- ─────────────────────────────────────────────────────────
-- §4.2.5 hw_alarms — HW_ALARM
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hw_alarms (
    time                            TIMESTAMPTZ     NOT NULL,
    message_id                      TEXT            NOT NULL,
    equipment_id                    TEXT            NOT NULL,
    equipment_status                TEXT            NOT NULL,
    alarm_level                     TEXT            NOT NULL,
    hw_error_code                   TEXT            NOT NULL,
    hw_error_source                 TEXT            NOT NULL,
    hw_error_detail                 TEXT            NOT NULL,
    exception_detail                JSONB,
    auto_recovery_attempted         BOOLEAN         NOT NULL,
    requires_manual_intervention    BOOLEAN         NOT NULL,
    burst_id                        TEXT,
    burst_count                     INTEGER,
    lot_id                          TEXT,
    payload_raw                     JSONB           NOT NULL
);

SELECT create_hypertable('hw_alarms', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_alarm_eq_time
    ON hw_alarms (equipment_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_level
    ON hw_alarms (alarm_level, time DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_error_code
    ON hw_alarms (hw_error_code, time DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_burst
    ON hw_alarms (burst_id, time DESC)
    WHERE burst_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alarm_recovery
    ON hw_alarms (hw_error_code, auto_recovery_attempted, time DESC);

-- ─────────────────────────────────────────────────────────
-- §4.2.6 recipe_changes — RECIPE_CHANGED
-- equipment_status는 항상 IDLE (비정상 전환 감지용)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recipe_changes (
    time                        TIMESTAMPTZ     NOT NULL,
    message_id                  TEXT            NOT NULL,
    equipment_id                TEXT            NOT NULL,
    equipment_status            TEXT            NOT NULL,
    previous_recipe_id          TEXT            NOT NULL,
    previous_recipe_version     TEXT            NOT NULL,
    new_recipe_id               TEXT            NOT NULL,
    new_recipe_version          TEXT            NOT NULL,
    changed_by                  TEXT            NOT NULL
);

SELECT create_hypertable('recipe_changes', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_recipe_eq_time
    ON recipe_changes (equipment_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_new
    ON recipe_changes (new_recipe_id, time DESC);

-- ─────────────────────────────────────────────────────────
-- §4.2.7 control_commands — CONTROL_CMD (감사 로그)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_commands (
    time                TIMESTAMPTZ     NOT NULL,
    message_id          TEXT            NOT NULL,
    equipment_id        TEXT            NOT NULL,
    command             TEXT            NOT NULL,
    issued_by           TEXT            NOT NULL,
    reason              TEXT,
    target_lot_id       TEXT,
    target_burst_id     TEXT
);

SELECT create_hypertable('control_commands', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_ctrl_eq_time
    ON control_commands (equipment_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_ctrl_command
    ON control_commands (command, time DESC);

-- ─────────────────────────────────────────────────────────
-- §4.2.8 oracle_analyses — ORACLE_ANALYSIS
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_analyses (
    time                    TIMESTAMPTZ         NOT NULL,
    message_id              TEXT                NOT NULL,
    equipment_id            TEXT                NOT NULL,
    lot_id                  TEXT                NOT NULL,
    recipe_id               TEXT                NOT NULL,
    judgment                TEXT                NOT NULL,
    yield_actual            DOUBLE PRECISION    NOT NULL,
    yield_status            JSONB               NOT NULL,
    isolation_forest_score  DOUBLE PRECISION,
    ai_comment              TEXT                NOT NULL,
    threshold_proposal      JSONB
);

SELECT create_hypertable('oracle_analyses', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_oracle_eq_time
    ON oracle_analyses (equipment_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_judgment
    ON oracle_analyses (judgment, time DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_recipe
    ON oracle_analyses (recipe_id, time DESC);

-- ─────────────────────────────────────────────────────────
-- §4.3 Retention Policy
-- heartbeat/status 90일, 나머지 365일
-- ─────────────────────────────────────────────────────────
SELECT add_retention_policy('heartbeats',         INTERVAL '90 days',  if_not_exists => TRUE);
SELECT add_retention_policy('status_updates',     INTERVAL '90 days',  if_not_exists => TRUE);
SELECT add_retention_policy('inspection_results', INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('lot_ends',           INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('hw_alarms',          INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('recipe_changes',     INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('control_commands',   INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('oracle_analyses',    INTERVAL '365 days', if_not_exists => TRUE);

-- ─────────────────────────────────────────────────────────
-- §4.4 Continuous Aggregate (lot_yield_hourly)는 H9에서 정식 적용
-- ─────────────────────────────────────────────────────────
