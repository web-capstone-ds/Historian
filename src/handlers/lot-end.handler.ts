import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';
import { getStatus } from '../utils/equipment-cache.js';

// LOT_END 페이로드에는 recipe_id/operator_id가 없다 — STATUS 캐시에서 enrichment (§10)
export interface LotEndPayload {
  message_id: string;
  event_type: 'LOT_END';
  timestamp: string;
  equipment_id: string;
  equipment_status: string;
  lot_id: string;
  lot_status: string;
  total_units: number;
  pass_count: number;
  fail_count: number;
  yield_pct: number;
  lot_duration_sec: number;
}

const INSERT_SQL = `
  INSERT INTO lot_ends (
    time, message_id, equipment_id, lot_id, lot_status,
    recipe_id, operator_id,
    total_units, pass_count, fail_count, yield_pct, lot_duration_sec
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7,
    $8, $9, $10, $11, $12
  )
`;

function parsePayload(payload: Buffer): LotEndPayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as LotEndPayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'LOT_END JSON parse failed, dropping message',
    );
    return null;
  }
}

export interface EnrichedLotEnd {
  recipe_id: string;
  operator_id: string;
  enriched: boolean;
}

// STATUS 캐시에서 recipe_id / operator_id 주입. 미존재 시 'UNKNOWN' + WARN
export function enrichLotEnd(equipmentId: string): EnrichedLotEnd {
  const cached = getStatus(equipmentId);
  if (cached) {
    return { recipe_id: cached.recipe_id, operator_id: cached.operator_id, enriched: true };
  }
  logger.warn(
    { equipmentId },
    'LOT_END enrichment: no cached STATUS found, using UNKNOWN',
  );
  return { recipe_id: 'UNKNOWN', operator_id: 'UNKNOWN', enriched: false };
}

export async function insertLotEnd(
  pool: DbPool,
  msg: LotEndPayload,
  enrichment: EnrichedLotEnd,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    msg.timestamp,
    msg.message_id,
    msg.equipment_id,
    msg.lot_id,
    msg.lot_status,
    enrichment.recipe_id,
    enrichment.operator_id,
    msg.total_units,
    msg.pass_count,
    msg.fail_count,
    msg.yield_pct,
    msg.lot_duration_sec,
  ]);
}

export async function handleLotEnd(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'LOT_END equipment_id mismatch',
    );
  }

  const enrichment = enrichLotEnd(msg.equipment_id);

  try {
    await insertLotEnd(getPool(), msg, enrichment);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
        lotId: msg.lot_id,
      },
      'LOT_END insert failed',
    );
  }
}
