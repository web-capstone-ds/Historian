// H10 통합 테스트 — Mock 27종 전수 적재 검증 + Oracle 연동 쿼리 5종
// 실행 전제: docker-compose up -d (TimescaleDB 기동), dist/ 빌드 완료
// 실행: node scripts/h10-live-check.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../dist/config/env.js';
import { initPool, getPool, closePool } from '../dist/db/pool.js';
import { handleHeartbeat } from '../dist/handlers/heartbeat.handler.js';
import { handleStatusUpdate } from '../dist/handlers/status.handler.js';
import { handleInspectionResult } from '../dist/handlers/inspection.handler.js';
import { handleLotEnd } from '../dist/handlers/lot-end.handler.js';
import { handleHwAlarm } from '../dist/handlers/alarm.handler.js';
import { handleRecipeChanged } from '../dist/handlers/recipe.handler.js';
import { handleControlCmd } from '../dist/handlers/control.handler.js';
import { handleOracleAnalysis } from '../dist/handlers/oracle.handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = resolve(__dirname, '../../DS-Document/EAP_mock_data');

// Mock 파일 → 핸들러 매핑 (CLAUDE.md §17 27종 표)
const MOCK_ROUTES = [
  { file: '01_heartbeat.json', handler: handleHeartbeat },
  { file: '02_status_run.json', handler: handleStatusUpdate },
  { file: '03_status_idle.json', handler: handleStatusUpdate },
  { file: '04_inspection_pass.json', handler: handleInspectionResult },
  { file: '05_inspection_fail_side_et52.json', handler: handleInspectionResult },
  { file: '06_inspection_fail_side_et12.json', handler: handleInspectionResult },
  { file: '07_inspection_fail_prs_offset.json', handler: handleInspectionResult },
  { file: '08_inspection_fail_side_mixed.json', handler: handleInspectionResult },
  { file: '09_lot_end_normal.json', handler: handleLotEnd },
  { file: '10_lot_end_aborted.json', handler: handleLotEnd },
  { file: '11_alarm_cam_timeout.json', handler: handleHwAlarm },
  { file: '12_alarm_write_image_fail.json', handler: handleHwAlarm },
  { file: '13_alarm_vision_null_object.json', handler: handleHwAlarm },
  { file: '14_alarm_light_param_err.json', handler: handleHwAlarm },
  { file: '15_alarm_side_vision_fail.json', handler: handleHwAlarm },
  { file: '16_alarm_lot_start_fail.json', handler: handleHwAlarm },
  { file: '17_alarm_eap_disconnected.json', handler: handleHwAlarm },
  { file: '18_recipe_changed_normal.json', handler: handleRecipeChanged },
  { file: '19_recipe_changed_new_4x6.json', handler: handleRecipeChanged },
  { file: '20_recipe_changed_446275.json', handler: handleRecipeChanged },
  { file: '21_control_emergency_stop.json', handler: handleControlCmd },
  { file: '22_control_status_query.json', handler: handleControlCmd },
  { file: '23_oracle_normal.json', handler: handleOracleAnalysis },
  { file: '24_oracle_warning.json', handler: handleOracleAnalysis },
  { file: '25_oracle_danger.json', handler: handleOracleAnalysis },
  { file: '26_control_alarm_ack.json', handler: handleControlCmd },
  { file: '27_control_alarm_ack_burst.json', handler: handleControlCmd },
];

// 검증 카운터
let pass = 0;
let fail = 0;
const failures = [];

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}: ${actual}`);
  } else {
    fail += 1;
    failures.push(`${label}: expected ${expected}, got ${actual}`);
    console.log(`  FAIL  ${label}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` (${detail})` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const env = loadEnv();
  initPool(env);
  const pool = getPool();

  // ─── 준비: 8개 테이블 초기화 ───
  await pool.query(
    'TRUNCATE heartbeats, status_updates, inspection_results, lot_ends, hw_alarms, recipe_changes, control_commands, oracle_analyses',
  );

  // ─── Mock 27종 전수 적재 (단건 경로: batchInserter 미초기화) ───
  console.log('=== 1. Mock 27종 전수 적재 ===');
  let ingestErrors = 0;
  for (const { file, handler } of MOCK_ROUTES) {
    try {
      const raw = readFileSync(resolve(MOCK_DIR, file));
      const msg = JSON.parse(raw.toString());
      // 21/22는 equipment_id 없음 → 토픽에서 DS-VIS-001 주입
      const eq = msg.equipment_id ?? 'DS-VIS-001';
      await handler(eq, raw);
    } catch (err) {
      ingestErrors += 1;
      console.error(`  ERR   ${file}: ${err.message}`);
    }
  }
  assertEq('ingest error count', ingestErrors, 0);

  // ─── 2. 각 테이블 row count 검증 ───
  console.log('\n=== 2. 테이블별 row count ===');
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM heartbeats)         AS heartbeats,
      (SELECT COUNT(*)::int FROM status_updates)     AS status_updates,
      (SELECT COUNT(*)::int FROM inspection_results) AS inspection_results,
      (SELECT COUNT(*)::int FROM lot_ends)           AS lot_ends,
      (SELECT COUNT(*)::int FROM hw_alarms)          AS hw_alarms,
      (SELECT COUNT(*)::int FROM recipe_changes)     AS recipe_changes,
      (SELECT COUNT(*)::int FROM control_commands)   AS control_commands,
      (SELECT COUNT(*)::int FROM oracle_analyses)    AS oracle_analyses
  `);
  const r = counts.rows[0];
  console.table([r]);
  assertEq('heartbeats count', r.heartbeats, 1);
  assertEq('status_updates count', r.status_updates, 2);
  assertEq('inspection_results count', r.inspection_results, 5);
  assertEq('lot_ends count', r.lot_ends, 2);
  assertEq('hw_alarms count', r.hw_alarms, 7);
  assertEq('recipe_changes count', r.recipe_changes, 3);
  assertEq('control_commands count', r.control_commands, 4);
  assertEq('oracle_analyses count', r.oracle_analyses, 3);

  // ─── 3. PASS drop 정책 (Mock 04) ───
  console.log('\n=== 3. PASS drop 정책 — Mock 04 ===');
  const passRow = (
    await pool.query(`
      SELECT
        inspection_detail IS NULL AS detail_null,
        geometric IS NULL         AS geo_null,
        bga IS NULL               AS bga_null,
        surface IS NULL           AS surface_null,
        singulation IS NULL       AS sing_null,
        inspection_duration_ms,
        takt_time_ms,
        algorithm_version
      FROM inspection_results
      WHERE overall_result = 'PASS' AND fail_count = 0
    `)
  ).rows[0];
  assertTrue('PASS.inspection_detail NULL', passRow?.detail_null === true);
  assertTrue('PASS.geometric NULL', passRow?.geo_null === true);
  assertTrue('PASS.bga NULL', passRow?.bga_null === true);
  assertTrue('PASS.surface NULL', passRow?.surface_null === true);
  assertTrue('PASS.singulation NULL', passRow?.sing_null === true);
  assertTrue(
    'PASS.process 3필드 유지',
    passRow?.inspection_duration_ms === 1200 &&
      passRow?.takt_time_ms === 1620 &&
      passRow?.algorithm_version === 'v4.3.1',
  );

  // ─── 4. FAIL 전체 적재 + PascalCase 보존 (Mock 05, 07) ───
  console.log('\n=== 4. FAIL 전체 적재 + PascalCase 보존 ===');
  const failCount = (
    await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM inspection_results
      WHERE overall_result = 'FAIL' AND inspection_detail IS NOT NULL
    `)
  ).rows[0].n;
  assertEq('FAIL rows with detail NOT NULL', failCount, 4);

  const pascalRow = (
    await pool.query(`
      SELECT inspection_detail->'prs_result'->0->>'ZAxisNum' AS za_num,
             inspection_detail->'prs_result'->0->>'InspectionResult' AS insp,
             inspection_detail->'prs_result'->0->>'ErrorType' AS et
      FROM inspection_results
      WHERE fail_reason_code = 'DIMENSION_OUT_OF_SPEC'
    `)
  ).rows[0];
  assertTrue('PascalCase ZAxisNum 보존', pascalRow?.za_num !== null && pascalRow?.za_num !== undefined);
  assertTrue('PascalCase InspectionResult 보존', pascalRow?.insp !== null && pascalRow?.insp !== undefined);
  assertTrue('PascalCase ErrorType 보존', pascalRow?.et !== null && pascalRow?.et !== undefined);

  // ─── 5. LOT_END enrichment (STATUS 캐시 → recipe_id/operator_id) ───
  console.log('\n=== 5. LOT_END enrichment (Mock 09/10) ===');
  const lotRows = (
    await pool.query(
      `SELECT lot_id, lot_status, recipe_id, operator_id, yield_pct
       FROM lot_ends ORDER BY time`,
    )
  ).rows;
  console.table(lotRows);
  assertTrue(
    'lot 09 recipe_id=Carsem_3X3 (enrichment)',
    lotRows[0]?.recipe_id === 'Carsem_3X3',
    `actual=${lotRows[0]?.recipe_id}`,
  );
  assertTrue(
    'lot 09 operator_id=ENG-KIM (enrichment)',
    lotRows[0]?.operator_id === 'ENG-KIM',
    `actual=${lotRows[0]?.operator_id}`,
  );

  // ─── 6. HW_ALARM payload_raw 원본 보존 ───
  console.log('\n=== 6. HW_ALARM payload_raw 보존 ===');
  const alarmRaw = (
    await pool.query(
      `SELECT payload_raw->'exception_detail'->>'exception_type' AS exc,
              payload_raw->>'hw_error_source' AS src
       FROM hw_alarms WHERE hw_error_code='CAM_TIMEOUT_ERR'`,
    )
  ).rows[0];
  assertTrue(
    'payload_raw.exception_detail.exception_type 보존',
    alarmRaw?.exc === 'OperationCanceledException',
    `actual=${alarmRaw?.exc}`,
  );

  // ─── 7. RECIPE_CHANGED equipment_status 전부 IDLE ───
  console.log('\n=== 7. RECIPE_CHANGED equipment_status=IDLE ===');
  const nonIdle = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM recipe_changes WHERE equipment_status <> 'IDLE'`,
    )
  ).rows[0].n;
  assertEq('recipe_changes non-IDLE rows', nonIdle, 0);

  // ─── 8. CONTROL_CMD burst_id 적재 (Mock 27) ───
  console.log('\n=== 8. CONTROL_CMD target_burst_id (Mock 27) ===');
  const ackBurst = (
    await pool.query(
      `SELECT command, target_burst_id FROM control_commands
       WHERE command='ALARM_ACK' AND target_burst_id IS NOT NULL`,
    )
  ).rows[0];
  assertTrue(
    'Mock 27 target_burst_id 적재',
    ackBurst?.target_burst_id === '8d9e1f2a-aggex-4abc-b100-000000000001',
    `actual=${ackBurst?.target_burst_id}`,
  );

  // ─── 9. ORACLE_ANALYSIS judgment 3종 ───
  console.log('\n=== 9. ORACLE_ANALYSIS judgment 분포 ===');
  const judgments = (
    await pool.query(
      `SELECT judgment, COUNT(*)::int AS n FROM oracle_analyses GROUP BY judgment ORDER BY judgment`,
    )
  ).rows;
  console.table(judgments);
  const judgSet = new Set(judgments.map((x) => x.judgment));
  assertTrue('judgment NORMAL 포함', judgSet.has('NORMAL'));
  assertTrue('judgment WARNING 포함', judgSet.has('WARNING'));
  assertTrue('judgment DANGER 포함', judgSet.has('DANGER'));

  // ─── 10. Oracle 연동 쿼리 5종 ───
  console.log('\n=== 10. Oracle 연동 쿼리 5종 ===');

  // ① LOT별 INSPECTION_RESULT 일괄 조회
  const q1 = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM inspection_results WHERE lot_id='LOT-20260122-001'`,
    )
  ).rows[0].n;
  assertTrue('Q1 lot_id=LOT-20260122-001 조회 (≥1)', q1 >= 1, `count=${q1}`);

  // ② 레시피별 최근 3 COMPLETED LOT 평균 total_units
  // (CAGG와 동일하게 ABORTED 제외 — 정상 생산 표본만 Oracle 2차 검증 입력)
  const q2 = (
    await pool.query(`
      SELECT AVG(total_units)::int AS avg_units
      FROM (SELECT total_units FROM lot_ends
            WHERE recipe_id='Carsem_3X3' AND lot_status='COMPLETED'
            ORDER BY time DESC LIMIT 3) s
    `)
  ).rows[0].avg_units;
  assertTrue('Q2 Carsem_3X3 최근 3 COMPLETED LOT 평균 total_units ≈ 2792', q2 === 2792, `avg=${q2}`);

  // ③ 레시피별 수율 시계열 (EWMA 입력)
  const q3 = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT yield_pct FROM lot_ends WHERE recipe_id='Carsem_3X3'
         ORDER BY time DESC LIMIT 28
       ) s`,
    )
  ).rows[0].n;
  assertTrue('Q3 Carsem_3X3 수율 시계열 LIMIT 28 반환 (≥1)', q3 >= 1, `count=${q3}`);

  // ④ 장비별 알람 카운터 R26 (CAM_TIMEOUT_ERR)
  // Mock timestamp가 2026-01이므로 "NOW()-1 day" 필터 대신 쿼리 형태 자체와 row 존재 확인
  const q4 = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM hw_alarms
       WHERE hw_error_code='CAM_TIMEOUT_ERR' AND equipment_id='DS-VIS-001'`,
    )
  ).rows[0].n;
  assertEq('Q4 DS-VIS-001 CAM_TIMEOUT_ERR 카운터', q4, 1);

  // ⑤ AggregateException 카운터 R33 (VISION_SCORE_ERR AND auto_recovery_attempted=false)
  const q5 = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM hw_alarms
       WHERE hw_error_code='VISION_SCORE_ERR' AND auto_recovery_attempted=false`,
    )
  ).rows[0].n;
  assertEq('Q5 VISION_SCORE_ERR × auto_recovery=false', q5, 3);

  // ─── 최종 요약 ───
  console.log('\n=== Summary ===');
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (fail > 0) {
    console.log('\n[FAILURES]');
    for (const f of failures) console.log(`  - ${f}`);
  }

  await closePool();
  if (fail > 0) process.exit(1);
  console.log('\n✓ H10 통합 테스트 검증 완료');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
