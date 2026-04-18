// H5 라이브 검증 — Mock 04~08을 inspection.handler로 적재 후 SELECT 확인
// 실행: node scripts/h5-live-check.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../dist/config/env.js';
import { initPool, getPool, closePool } from '../dist/db/pool.js';
import { handleInspectionResult } from '../dist/handlers/inspection.handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = resolve(__dirname, '../../DS-Document/EAP_mock_data');

const files = [
  '04_inspection_pass.json',
  '05_inspection_fail_side_et52.json',
  '06_inspection_fail_side_et12.json',
  '07_inspection_fail_prs_offset.json',
  '08_inspection_fail_side_mixed.json',
];

async function main() {
  const env = loadEnv();
  initPool(env);
  const pool = getPool();

  // clean slate
  await pool.query('TRUNCATE inspection_results');

  for (const f of files) {
    const raw = readFileSync(resolve(MOCK_DIR, f));
    const msg = JSON.parse(raw.toString());
    await handleInspectionResult(msg.equipment_id, raw);
    console.log(`  injected ${f}`);
  }

  console.log('\n--- SELECT count ---');
  const { rows: countRows } = await pool.query(
    `SELECT overall_result, fail_reason_code, fail_count, total_inspected_count FROM inspection_results ORDER BY time`,
  );
  console.table(countRows);

  console.log('\n--- PASS drop 검증 (Mock 04) ---');
  const { rows: passRows } = await pool.query(`
    SELECT
      inspection_detail IS NULL AS detail_null,
      geometric IS NULL AS geo_null,
      bga IS NULL AS bga_null,
      surface IS NULL AS surface_null,
      singulation IS NULL AS sing_null,
      inspection_duration_ms,
      takt_time_ms,
      algorithm_version
    FROM inspection_results
    WHERE overall_result = 'PASS'
  `);
  console.table(passRows);

  console.log('\n--- FAIL 전체 적재 검증 (Mock 05 SIDE ET=52) ---');
  const { rows: failRows } = await pool.query(`
    SELECT
      fail_reason_code,
      fail_count,
      singulation->>'chipping_top_um' AS chipping_top,
      singulation->>'burr_height_um' AS burr,
      inspection_detail->'side_result'->0->>'ErrorType' AS side_et_za0
    FROM inspection_results
    WHERE fail_reason_code = 'SIDE_VISION_FAIL' AND fail_count = 8
  `);
  console.table(failRows);

  console.log('\n--- PascalCase 보존 검증 (Mock 07 PRS ET=11) ---');
  const { rows: pascalRows } = await pool.query(`
    SELECT
      inspection_detail->'prs_result'->0->>'ZAxisNum' AS za_num,
      inspection_detail->'prs_result'->0->>'InspectionResult' AS insp_result,
      inspection_detail->'prs_result'->0->>'ErrorType' AS err_type,
      inspection_detail->'prs_result'->0->>'XOffset' AS xoff,
      inspection_detail->'prs_result'->0->>'YOffset' AS yoff
    FROM inspection_results
    WHERE fail_reason_code = 'DIMENSION_OUT_OF_SPEC'
  `);
  console.table(pascalRows);

  console.log('\n--- Mock 08 혼재 패턴 검증 ---');
  const { rows: mixedRows } = await pool.query(`
    SELECT
      fail_count,
      inspection_detail->'side_result'->1->>'ErrorType' AS za1_et,
      inspection_detail->'side_result'->4->>'ErrorType' AS za4_et
    FROM inspection_results
    WHERE lot_id = 'LOT-20260127-001'
  `);
  console.table(mixedRows);

  await closePool();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
