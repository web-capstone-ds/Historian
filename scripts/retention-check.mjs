// Retention Policy 등록 검증 — 8개 Hypertable에 정책이 올바른 기간으로 등록되어 있는지 확인
// 장기 운영 검증(시간 경과 후 drop) 대신 "policy job이 스케줄되었는가"를 즉시 확인한다.
// 실행: node scripts/retention-check.mjs
import 'dotenv/config';
import { loadEnv } from '../dist/config/env.js';
import { initPool, getPool, closePool } from '../dist/db/pool.js';

// 작업명세서 §4.3: heartbeat/status 90일, 나머지 365일
const EXPECTED = new Map([
  ['heartbeats', '90 days'],
  ['status_updates', '90 days'],
  ['inspection_results', '365 days'],
  ['lot_ends', '365 days'],
  ['hw_alarms', '365 days'],
  ['recipe_changes', '365 days'],
  ['control_commands', '365 days'],
  ['oracle_analyses', '365 days'],
]);

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = '') {
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

  const { rows } = await pool.query(`
    SELECT hypertable_name,
           (config->>'drop_after') AS drop_after,
           scheduled,
           schedule_interval
    FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention'
    ORDER BY hypertable_name
  `);

  console.log('=== Retention Policy 등록 현황 ===');
  console.table(rows);

  const byTable = new Map(rows.map((r) => [r.hypertable_name, r]));

  console.log('\n=== 검증: 8개 테이블 × (drop_after, scheduled=true) ===');
  for (const [table, expected] of EXPECTED) {
    const row = byTable.get(table);
    check(`${table} policy 등록됨`, row != null);
    if (!row) continue;
    check(
      `${table} drop_after=${expected}`,
      row.drop_after === expected,
      `actual=${row.drop_after}`,
    );
    check(`${table} scheduled=true`, row.scheduled === true, `actual=${row.scheduled}`);
  }

  // 명세 외 정책이 추가로 붙었는지 확인 (소리없이 누적되면 운영상 혼란)
  const extra = rows.filter((r) => !EXPECTED.has(r.hypertable_name));
  check(
    '명세 외 테이블에 retention 정책 없음',
    extra.length === 0,
    extra.length === 0 ? '' : `unexpected: ${extra.map((r) => r.hypertable_name).join(',')}`,
  );

  console.log('\n=== Summary ===');
  console.log(`  PASS: ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (fail > 0) {
    console.log('\n[FAILURES]');
    for (const f of failures) console.log(`  - ${f}`);
  }

  await closePool();
  if (fail > 0) process.exit(1);
  console.log('\n✓ Retention Policy 등록 검증 완료');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
