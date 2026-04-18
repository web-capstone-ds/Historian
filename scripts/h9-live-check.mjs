// H9 라이브 검증 — lot_yield_hourly Continuous Aggregate
// 실행: node scripts/h9-live-check.mjs
import 'dotenv/config';
import { loadEnv } from '../dist/config/env.js';
import { initPool, getPool, closePool } from '../dist/db/pool.js';

async function main() {
  const env = loadEnv();
  initPool(env);
  const pool = getPool();

  // ─── 준비: 테스트용 LOT_END 10건 주입 ───
  // 동일 recipe+equipment, 서로 다른 시각(같은 시간 버킷)
  await pool.query(`DELETE FROM lot_ends WHERE lot_id LIKE 'H9-CAGG-%'`);

  const base = new Date('2026-04-17T10:00:00.000Z'); // 어제 시각 (CAGG 정책 end_offset=1h 커버)
  const recipe = 'CAGG_TEST_RECIPE';
  const eq = 'DS-VIS-H9';

  console.log('[prep] inserting 10 COMPLETED LOTs into same bucket');
  for (let i = 0; i < 10; i += 1) {
    const t = new Date(base.getTime() + i * 60_000).toISOString();
    const yieldPct = 95 + i * 0.2; // 95.0 ~ 96.8
    await pool.query(
      `INSERT INTO lot_ends
       (time, message_id, equipment_id, lot_id, lot_status, recipe_id, operator_id,
        total_units, pass_count, fail_count, yield_pct, lot_duration_sec)
       VALUES ($1,$2,$3,$4,'COMPLETED',$5,'op',1000,950,50,$6,4920)`,
      [t, `h9-${i}`, eq, `H9-CAGG-${i}`, recipe, yieldPct],
    );
  }

  // 1건은 ABORTED로 넣어 WHERE lot_status='COMPLETED' 필터 검증
  await pool.query(
    `INSERT INTO lot_ends
     (time, message_id, equipment_id, lot_id, lot_status, recipe_id, operator_id,
      total_units, pass_count, fail_count, yield_pct, lot_duration_sec)
     VALUES ($1,$2,$3,$4,'ABORTED',$5,'op',500,400,100,80.0,2400)`,
    [new Date(base.getTime() + 11 * 60_000).toISOString(), 'h9-ab', eq, 'H9-CAGG-AB', recipe],
  );

  // ─── CAGG 수동 refresh ───
  console.log('[refresh] CALL refresh_continuous_aggregate manually');
  await pool.query(
    `CALL refresh_continuous_aggregate('lot_yield_hourly', $1::timestamptz, $2::timestamptz)`,
    [
      new Date(base.getTime() - 60 * 60_000).toISOString(),
      new Date(base.getTime() + 2 * 60 * 60_000).toISOString(),
    ],
  );

  // ─── 검증 ───
  const result = await pool.query(
    `SELECT bucket, equipment_id, recipe_id, lot_count,
            ROUND(avg_yield::numeric, 2) AS avg_yield,
            ROUND(min_yield::numeric, 2) AS min_yield,
            ROUND(max_yield::numeric, 2) AS max_yield,
            ROUND(avg_duration::numeric, 0) AS avg_duration
     FROM lot_yield_hourly
     WHERE recipe_id = $1
     ORDER BY bucket`,
    [recipe],
  );

  console.log('\n=== lot_yield_hourly (recipe=CAGG_TEST_RECIPE) ===');
  console.table(result.rows);

  const row = result.rows[0];
  if (!row) {
    console.error('FAIL: CAGG에 데이터 없음');
    process.exit(1);
  }

  // 검증: lot_count=10 (ABORTED 제외), avg_yield=95.9, min=95.0, max=96.8, avg_duration=4920
  const checks = [
    ['lot_count', Number(row.lot_count), 10],
    ['avg_yield', Number(row.avg_yield), 95.9],
    ['min_yield', Number(row.min_yield), 95.0],
    ['max_yield', Number(row.max_yield), 96.8],
    ['avg_duration', Number(row.avg_duration), 4920],
  ];

  let ok = true;
  for (const [label, actual, expected] of checks) {
    const pass = Math.abs(actual - expected) < 0.01;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${label}=${actual} (expected ${expected})`);
    if (!pass) ok = false;
  }

  // cleanup
  await pool.query(`DELETE FROM lot_ends WHERE lot_id LIKE 'H9-CAGG-%'`);

  await closePool();
  if (!ok) process.exit(1);
  console.log('\n✓ H9 CAGG 검증 완료');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
