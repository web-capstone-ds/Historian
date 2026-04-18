// H7 라이브 검증 — 배치 INSERT 실제 DB 적재
// 실행: node scripts/h7-live-check.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../dist/config/env.js';
import { initPool, getPool, closePool } from '../dist/db/pool.js';
import {
  initInspectionBatchInserter,
  getInspectionBatchInserter,
  handleInspectionResult,
} from '../dist/handlers/inspection.handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = resolve(__dirname, '../../DS-Document/EAP_mock_data');

function loadMockBuf(name) {
  return readFileSync(resolve(MOCK_DIR, name));
}

async function main() {
  const env = loadEnv();
  initPool(env);
  const pool = getPool();
  await pool.query('TRUNCATE inspection_results');

  const inserter = initInspectionBatchInserter(pool, env.batch.size, env.batch.flushIntervalMs);
  console.log(
    `[init] batch size=${env.batch.size}, flushInterval=${env.batch.flushIntervalMs}ms`,
  );

  // ─── 시나리오 1: 100건 유입 → 자동 size 플러시 ───
  console.log('\n[scenario 1] enqueue 100 PASS rows → expect single size-triggered flush');
  const passBuf = loadMockBuf('04_inspection_pass.json');
  for (let i = 0; i < 100; i += 1) {
    // unit_id를 매번 바꿔서 중복 방지
    const base = JSON.parse(passBuf.toString());
    base.unit_id = `UNIT-${String(i).padStart(4, '0')}`;
    base.message_id = `${base.message_id.slice(0, -4)}${String(i).padStart(4, '0')}`;
    await handleInspectionResult(base.equipment_id, Buffer.from(JSON.stringify(base)));
  }
  // 이벤트 루프에 플러시 실행 기회 부여
  await new Promise((r) => setTimeout(r, 200));

  const after100 = await pool.query('SELECT COUNT(*)::int AS n FROM inspection_results');
  console.log(`  → DB count after 100 enqueues: ${after100.rows[0].n}`);

  // ─── 시나리오 2: 50건 유입 (size 미달) → 타이머 플러시 ───
  console.log('\n[scenario 2] enqueue 50 FAIL rows → expect timer-triggered flush within 1s');
  const failBuf = loadMockBuf('05_inspection_fail_side_et52.json');
  for (let i = 0; i < 50; i += 1) {
    const base = JSON.parse(failBuf.toString());
    base.unit_id = `UNIT-FAIL-${String(i).padStart(4, '0')}`;
    base.message_id = `${base.message_id.slice(0, -4)}${String(i).padStart(4, '0')}`;
    await handleInspectionResult(base.equipment_id, Buffer.from(JSON.stringify(base)));
  }
  const beforeTimer = await pool.query('SELECT COUNT(*)::int AS n FROM inspection_results');
  console.log(`  → DB count right after 50 enqueue (pre-timer): ${beforeTimer.rows[0].n}`);

  // 타이머 대기
  await new Promise((r) => setTimeout(r, env.batch.flushIntervalMs + 200));
  const afterTimer = await pool.query('SELECT COUNT(*)::int AS n FROM inspection_results');
  console.log(`  → DB count after timer flush: ${afterTimer.rows[0].n}`);

  // ─── 시나리오 3: stop() Graceful shutdown — 잔여 드레인 ───
  console.log('\n[scenario 3] enqueue 7 rows then stop() → expect drain on shutdown');
  for (let i = 0; i < 7; i += 1) {
    const base = JSON.parse(passBuf.toString());
    base.unit_id = `UNIT-SHUT-${String(i).padStart(4, '0')}`;
    base.message_id = `${base.message_id.slice(0, -4)}${String(i).padStart(4, '0')}`;
    await handleInspectionResult(base.equipment_id, Buffer.from(JSON.stringify(base)));
  }
  const beforeStop = await pool.query('SELECT COUNT(*)::int AS n FROM inspection_results');
  console.log(`  → DB count before stop(): ${beforeStop.rows[0].n}`);

  await inserter.stop();
  const afterStop = await pool.query('SELECT COUNT(*)::int AS n FROM inspection_results');
  console.log(`  → DB count after stop():  ${afterStop.rows[0].n}`);

  // ─── 검증 요약 ───
  console.log('\n=== Summary ===');
  const sum = await pool.query(`
    SELECT overall_result, COUNT(*)::int AS cnt
    FROM inspection_results
    GROUP BY overall_result ORDER BY overall_result
  `);
  console.table(sum.rows);

  const passDropCheck = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE overall_result='PASS' AND inspection_detail IS NULL)::int AS pass_with_null_detail,
      COUNT(*) FILTER (WHERE overall_result='PASS' AND inspection_detail IS NOT NULL)::int AS pass_with_detail,
      COUNT(*) FILTER (WHERE overall_result='FAIL' AND inspection_detail IS NOT NULL)::int AS fail_with_detail
    FROM inspection_results
  `);
  console.log('PASS drop 정책 유지 확인:');
  console.table(passDropCheck.rows);

  await closePool();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
