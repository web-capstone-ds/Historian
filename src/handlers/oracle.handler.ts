import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';

// yield_actual은 schema에선 독립 컬럼이나 페이로드에선 yield_status.actual에 존재 → 추출 적재
export interface OracleAnalysisPayload {
  message_id: string;
  event_type: 'ORACLE_ANALYSIS';
  timestamp: string;
  equipment_id: string;
  lot_id: string;
  recipe_id: string;
  judgment: 'NORMAL' | 'WARNING' | 'DANGER';
  yield_status: {
    actual: number;
    dynamic_threshold?: unknown;
    lot_basis?: number;
  };
  isolation_forest_score?: number | null;
  ai_comment: string;
  threshold_proposal?: unknown | null;
}

const INSERT_SQL = `
  INSERT INTO oracle_analyses (
    time, message_id, equipment_id, lot_id, recipe_id,
    judgment, yield_actual, yield_status, isolation_forest_score,
    ai_comment, threshold_proposal
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9,
    $10, $11
  )
`;

function parsePayload(payload: Buffer): OracleAnalysisPayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as OracleAnalysisPayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'ORACLE_ANALYSIS JSON parse failed, dropping message',
    );
    return null;
  }
}

export async function insertOracleAnalysis(
  pool: DbPool,
  msg: OracleAnalysisPayload,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    msg.timestamp,
    msg.message_id,
    msg.equipment_id,
    msg.lot_id,
    msg.recipe_id,
    msg.judgment,
    msg.yield_status.actual,
    JSON.stringify(msg.yield_status),
    msg.isolation_forest_score ?? null,
    msg.ai_comment,
    msg.threshold_proposal == null ? null : JSON.stringify(msg.threshold_proposal),
  ]);
}

export async function handleOracleAnalysis(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'ORACLE_ANALYSIS equipment_id mismatch',
    );
  }

  try {
    await insertOracleAnalysis(getPool(), msg);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
        lotId: msg.lot_id,
        judgment: msg.judgment,
      },
      'ORACLE_ANALYSIS insert failed',
    );
  }
}
