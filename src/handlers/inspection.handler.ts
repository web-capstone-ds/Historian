import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';

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

const INSERT_SQL = `
  INSERT INTO inspection_results (
    time, message_id, equipment_id, lot_id, unit_id, strip_id,
    recipe_id, recipe_version, operator_id,
    overall_result, fail_reason_code, fail_count, total_inspected_count,
    inspection_duration_ms, takt_time_ms, algorithm_version,
    inspection_detail, geometric, bga, surface, singulation
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9,
    $10, $11, $12, $13,
    $14, $15, $16,
    $17, $18, $19, $20, $21
  )
`;

function parsePayload(payload: Buffer): InspectionPayload | null {
  try {
    const obj = JSON.parse(payload.toString('utf8')) as InspectionPayload;
    return obj;
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

export async function insertInspectionResult(
  pool: DbPool,
  msg: InspectionPayload,
): Promise<void> {
  const pass = isPassDrop(msg);

  // PASS drop: detail 그룹 전부 NULL (JSONB 컬럼은 JSON 문자열로 직렬화)
  const inspectionDetail = pass ? null : JSON.stringify(msg.inspection_detail ?? null);
  const geometric = pass ? null : JSON.stringify(msg.geometric ?? null);
  const bga = pass ? null : JSON.stringify(msg.bga ?? null);
  const surface = pass ? null : JSON.stringify(msg.surface ?? null);
  const singulation = pass ? null : JSON.stringify(msg.singulation ?? null);

  const params = [
    msg.timestamp, // $1 time — 원본 ISO 8601 UTC 그대로
    msg.message_id, // $2
    msg.equipment_id, // $3
    msg.lot_id, // $4
    msg.unit_id, // $5
    msg.strip_id, // $6
    msg.recipe_id, // $7
    msg.recipe_version, // $8
    msg.operator_id, // $9
    msg.overall_result, // $10
    msg.fail_reason_code, // $11
    msg.fail_count, // $12
    msg.total_inspected_count, // $13
    msg.process.inspection_duration_ms, // $14
    msg.process.takt_time_ms, // $15
    msg.process.algorithm_version, // $16
    inspectionDetail, // $17
    geometric, // $18
    bga, // $19
    surface, // $20
    singulation, // $21
  ];

  await pool.query(INSERT_SQL, params);
}

export async function handleInspectionResult(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  // 토픽의 equipment_id와 페이로드의 equipment_id 불일치 감지 (경고만, 적재는 진행)
  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'INSPECTION_RESULT equipment_id mismatch between topic and payload',
    );
  }

  const pool = getPool();

  try {
    await insertInspectionResult(pool, msg);
    logger.debug(
      {
        equipmentId: msg.equipment_id,
        lotId: msg.lot_id,
        unitId: msg.unit_id,
        overall: msg.overall_result,
        passDrop: isPassDrop(msg),
      },
      'INSPECTION_RESULT inserted',
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
