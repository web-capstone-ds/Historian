import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';
import { BatchInserter } from '../db/batch-inserter.js';

// 작업명세서 §3.2 / §6.2 INSPECTION_RESULT 페이로드
export interface InspectionPayload {
  message_id: string;
  event_type: 'INSPECTION_RESULT';
  timestamp: string;
  equipment_id: string;
  lot_id: string;
  strip_id: string;
  unit_id: string;
  recipe_id: string;
  recipe_version: string;
  operator_id: string;
  overall_result: 'PASS' | 'FAIL';
  fail_reason_code: string | null;
  fail_count: number;
  total_inspected_count: number;
  inspection_detail?: unknown;
  geometric?: unknown;
  bga?: unknown;
  surface?: unknown;
  singulation?: unknown;
  process: {
    inspection_duration_ms: number;
    takt_time_ms: number;
    algorithm_version: string;
  };
}

const INSERT_COLUMNS = `
  time, message_id, equipment_id, lot_id, unit_id, strip_id,
  recipe_id, recipe_version, operator_id,
  overall_result, fail_reason_code, fail_count, total_inspected_count,
  inspection_duration_ms, takt_time_ms, algorithm_version,
  inspection_detail, geometric, bga, surface, singulation
`;

const COLUMNS_PER_ROW = 21;

const INSERT_PREFIX = `INSERT INTO inspection_results (${INSERT_COLUMNS})`;

const SINGLE_INSERT_SQL = `${INSERT_PREFIX} VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9,
  $10, $11, $12, $13,
  $14, $15, $16,
  $17, $18, $19, $20, $21
)`;

function parsePayload(payload: Buffer): InspectionPayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as InspectionPayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'INSPECTION_RESULT JSON parse failed, dropping message',
    );
    return null;
  }
}

// PASS drop 정책: overall_result=PASS AND fail_count=0 → detail/geometric/bga/surface/singulation NULL
export function isPassDrop(msg: InspectionPayload): boolean {
  return msg.overall_result === 'PASS' && msg.fail_count === 0;
}

// 공통 파라미터 직렬화 — 단건/배치 경로 공유
export function serializeInspectionRow(msg: InspectionPayload): unknown[] {
  const pass = isPassDrop(msg);
  const inspectionDetail = pass ? null : JSON.stringify(msg.inspection_detail ?? null);
  const geometric = pass ? null : JSON.stringify(msg.geometric ?? null);
  const bga = pass ? null : JSON.stringify(msg.bga ?? null);
  const surface = pass ? null : JSON.stringify(msg.surface ?? null);
  const singulation = pass ? null : JSON.stringify(msg.singulation ?? null);

  return [
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
    msg.fail_reason_code,
    msg.fail_count,
    msg.total_inspected_count,
    msg.process.inspection_duration_ms,
    msg.process.takt_time_ms,
    msg.process.algorithm_version,
    inspectionDetail,
    geometric,
    bga,
    surface,
    singulation,
  ];
}

// 단건 insert — 테스트 및 비-배치 경로용
export async function insertInspectionResult(
  pool: DbPool,
  msg: InspectionPayload,
): Promise<void> {
  await pool.query(SINGLE_INSERT_SQL, serializeInspectionRow(msg));
}

// 배치 인서터 — index.ts에서 초기화
let batchInserter: BatchInserter<InspectionPayload> | null = null;

export function initInspectionBatchInserter(
  pool: DbPool,
  size: number,
  flushIntervalMs: number,
): BatchInserter<InspectionPayload> {
  if (batchInserter) return batchInserter;
  batchInserter = new BatchInserter<InspectionPayload>({
    name: 'inspection_results',
    pool,
    size,
    flushIntervalMs,
    columnsPerRow: COLUMNS_PER_ROW,
    insertPrefix: INSERT_PREFIX,
    serializeRow: serializeInspectionRow,
  });
  return batchInserter;
}

export function getInspectionBatchInserter(): BatchInserter<InspectionPayload> | null {
  return batchInserter;
}

// 테스트 전용
export function _setInspectionBatchInserterForTest(
  inserter: BatchInserter<InspectionPayload> | null,
): void {
  batchInserter = inserter;
}

export async function handleInspectionResult(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'INSPECTION_RESULT equipment_id mismatch between topic and payload',
    );
  }

  // 배치 인서터가 초기화돼 있으면 배치 경로, 아니면 단건 경로로 폴백
  if (batchInserter) {
    batchInserter.enqueue(msg);
    logger.debug(
      {
        equipmentId: msg.equipment_id,
        lotId: msg.lot_id,
        unitId: msg.unit_id,
        overall: msg.overall_result,
        passDrop: isPassDrop(msg),
      },
      'INSPECTION_RESULT enqueued',
    );
    return;
  }

  try {
    await insertInspectionResult(getPool(), msg);
    logger.debug(
      {
        equipmentId: msg.equipment_id,
        lotId: msg.lot_id,
        unitId: msg.unit_id,
        overall: msg.overall_result,
        passDrop: isPassDrop(msg),
      },
      'INSPECTION_RESULT inserted (single)',
    );
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
        lotId: msg.lot_id,
        unitId: msg.unit_id,
      },
      'INSPECTION_RESULT insert failed',
    );
  }
}
