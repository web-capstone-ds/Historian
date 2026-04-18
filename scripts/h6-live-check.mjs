// H6 라이브 검증 — 7종 이벤트 핸들러 Mock 적재 후 SELECT 확인
// 실행: node scripts/h6-live-check.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../dist/config/env.js';
import { initPool, getPool, closePool } from '../dist/db/pool.js';
import { handleHeartbeat } from '../dist/handlers/heartbeat.handler.js';
import { handleStatusUpdate } from '../dist/handlers/status.handler.js';
import { handleLotEnd } from '../dist/handlers/lot-end.handler.js';
import { handleHwAlarm } from '../dist/handlers/alarm.handler.js';
import { handleRecipeChanged } from '../dist/handlers/recipe.handler.js';
import { handleControlCmd } from '../dist/handlers/control.handler.js';
import { handleOracleAnalysis } from '../dist/handlers/oracle.handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = resolve(__dirname, '../../DS-Document/EAP_mock_data');

function load(name) {
  const raw = readFileSync(resolve(MOCK_DIR, name));
  const msg = JSON.parse(raw.toString());
  return { raw, msg };
}

async function main() {
  const env = loadEnv();
  initPool(env);
  const pool = getPool();

  // clean slate
  await pool.query(
    'TRUNCATE heartbeats, status_updates, lot_ends, hw_alarms, recipe_changes, control_commands, oracle_analyses',
  );

  // --- HEARTBEAT ---
  {
    const { raw, msg } = load('01_heartbeat.json');
    await handleHeartbeat(msg.equipment_id, raw);
  }

  // --- STATUS_UPDATE (RUN / IDLE) ---
  // RUN 먼저 적재 → equipment-cache에 recipe_id/operator_id 저장됨
  for (const f of ['02_status_run.json', '03_status_idle.json']) {
    const { raw, msg } = load(f);
    await handleStatusUpdate(msg.equipment_id, raw);
  }

  // --- LOT_END (enrichment: STATUS 캐시에서 Carsem_3X3 / ENG-KIM 주입) ---
  for (const f of ['09_lot_end_normal.json', '10_lot_end_aborted.json']) {
    const { raw, msg } = load(f);
    await handleLotEnd(msg.equipment_id, raw);
  }

  // --- HW_ALARM 7종 ---
  for (const f of [
    '11_alarm_cam_timeout.json',
    '12_alarm_write_image_fail.json',
    '13_alarm_vision_null_object.json',
    '14_alarm_light_param_err.json',
    '15_alarm_side_vision_fail.json',
    '16_alarm_lot_start_fail.json',
    '17_alarm_eap_disconnected.json',
  ]) {
    const { raw, msg } = load(f);
    await handleHwAlarm(msg.equipment_id, raw);
  }

  // --- RECIPE_CHANGED 3종 ---
  for (const f of [
    '18_recipe_changed_normal.json',
    '19_recipe_changed_new_4x6.json',
    '20_recipe_changed_446275.json',
  ]) {
    const { raw, msg } = load(f);
    await handleRecipeChanged(msg.equipment_id, raw);
  }

  // --- CONTROL_CMD 4종 (Mock 21/22: equipment_id 없음 — 토픽에서 주입) ---
  for (const f of [
    '21_control_emergency_stop.json',
    '22_control_status_query.json',
    '26_control_alarm_ack.json',
    '27_control_alarm_ack_burst.json',
  ]) {
    const { raw, msg } = load(f);
    // Mock 21/22는 equipment_id 없음 → 토픽 값으로 DS-VIS-001 주입
    const eq = msg.equipment_id ?? 'DS-VIS-001';
    await handleControlCmd(eq, raw);
  }

  // --- ORACLE_ANALYSIS 3종 ---
  for (const f of ['23_oracle_normal.json', '24_oracle_warning.json', '25_oracle_danger.json']) {
    const { raw, msg } = load(f);
    await handleOracleAnalysis(msg.equipment_id, raw);
  }

  // ─── SELECT 검증 ───
  console.log('\n=== HEARTBEAT ===');
  console.table((await pool.query('SELECT time, equipment_id FROM heartbeats')).rows);

  console.log('\n=== STATUS_UPDATE (진행률 3필드) ===');
  console.table(
    (
      await pool.query(
        'SELECT equipment_status, current_unit_count, expected_total_units, current_yield_pct, recipe_id FROM status_updates ORDER BY time',
      )
    ).rows,
  );

  console.log('\n=== LOT_END enrichment (recipe_id / operator_id) ===');
  console.table(
    (
      await pool.query(
        'SELECT lot_id, lot_status, recipe_id, operator_id, total_units, yield_pct, lot_duration_sec FROM lot_ends ORDER BY time',
      )
    ).rows,
  );

  console.log('\n=== HW_ALARM 7종 ===');
  console.table(
    (
      await pool.query(
        'SELECT alarm_level, hw_error_code, hw_error_source, burst_id IS NULL AS burst_null, requires_manual_intervention FROM hw_alarms ORDER BY time',
      )
    ).rows,
  );

  console.log('\n=== HW_ALARM payload_raw 보존 (11번 CAM_TIMEOUT) ===');
  console.table(
    (
      await pool.query(
        `SELECT payload_raw->>'event_type' AS etype, payload_raw->'exception_detail'->>'exception_type' AS exc FROM hw_alarms WHERE hw_error_code='CAM_TIMEOUT_ERR'`,
      )
    ).rows,
  );

  console.log('\n=== RECIPE_CHANGED (equipment_status 항상 IDLE 검증) ===');
  console.table(
    (
      await pool.query(
        'SELECT equipment_status, previous_recipe_id, new_recipe_id, changed_by FROM recipe_changes ORDER BY time',
      )
    ).rows,
  );

  console.log('\n=== CONTROL_CMD 감사 로그 ===');
  console.table(
    (
      await pool.query(
        'SELECT command, issued_by, target_lot_id, target_burst_id FROM control_commands ORDER BY time',
      )
    ).rows,
  );

  console.log('\n=== ORACLE_ANALYSIS 3종 ===');
  console.table(
    (
      await pool.query(
        'SELECT judgment, recipe_id, yield_actual, isolation_forest_score, threshold_proposal IS NULL AS tp_null FROM oracle_analyses ORDER BY time',
      )
    ).rows,
  );

  await closePool();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
