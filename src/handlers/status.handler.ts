import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';
import { upsertStatus } from '../utils/equipment-cache.js';

export interface StatusUpdatePayload {
  message_id: string;
  event_type: 'STATUS_UPDATE';
  timestamp: string;
  equipment_id: string;
  equipment_status: string;
  lot_id: string;
  recipe_id: string;
  recipe_version: string;
  operator_id: string;
  uptime_sec: number;
  current_unit_count: number | null;
  expected_total_units: number | null;
  current_yield_pct: number | null;
}

const INSERT_SQL = `
  INSERT INTO status_updates (
    time, message_id, equipment_id, equipment_status,
    lot_id, recipe_id, recipe_version, operator_id,
    uptime_sec, current_unit_count, expected_total_units, current_yield_pct
  ) VALUES (
    $1, $2, $3, $4,
    $5, $6, $7, $8,
    $9, $10, $11, $12
  )
`;

function parsePayload(payload: Buffer): StatusUpdatePayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as StatusUpdatePayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'STATUS_UPDATE JSON parse failed, dropping message',
    );
    return null;
  }
}

export async function insertStatusUpdate(
  pool: DbPool,
  msg: StatusUpdatePayload,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    msg.timestamp,
    msg.message_id,
    msg.equipment_id,
    msg.equipment_status,
    msg.lot_id,
    msg.recipe_id,
    msg.recipe_version,
    msg.operator_id,
    msg.uptime_sec,
    msg.current_unit_count ?? null,
    msg.expected_total_units ?? null,
    msg.current_yield_pct ?? null,
  ]);
}

export async function handleStatusUpdate(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'STATUS_UPDATE equipment_id mismatch',
    );
  }

  // LOT_END enrichment용 캐시 갱신 (H11)
  upsertStatus(msg.equipment_id, {
    recipe_id: msg.recipe_id,
    operator_id: msg.operator_id,
  });

  try {
    await insertStatusUpdate(getPool(), msg);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
      },
      'STATUS_UPDATE insert failed',
    );
  }
}
