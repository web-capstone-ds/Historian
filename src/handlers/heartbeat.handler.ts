import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';

export interface HeartbeatPayload {
  message_id: string;
  event_type: 'HEARTBEAT';
  timestamp: string;
  equipment_id: string;
}

const INSERT_SQL = `
  INSERT INTO heartbeats (time, message_id, equipment_id)
  VALUES ($1, $2, $3)
`;

function parsePayload(payload: Buffer): HeartbeatPayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as HeartbeatPayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'HEARTBEAT JSON parse failed, dropping message',
    );
    return null;
  }
}

export async function insertHeartbeat(
  pool: DbPool,
  msg: HeartbeatPayload,
): Promise<void> {
  await pool.query(INSERT_SQL, [msg.timestamp, msg.message_id, msg.equipment_id]);
}

export async function handleHeartbeat(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'HEARTBEAT equipment_id mismatch',
    );
  }

  try {
    await insertHeartbeat(getPool(), msg);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
      },
      'HEARTBEAT insert failed',
    );
  }
}
