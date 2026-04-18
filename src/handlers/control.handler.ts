import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';

// CONTROL_CMD — Mock 21/22는 payload에 equipment_id가 없음. 토픽에서 추출한 값을 신뢰 소스로 사용.
export interface ControlCmdPayload {
  message_id: string;
  event_type: 'CONTROL_CMD';
  timestamp: string;
  equipment_id?: string;
  command: string;
  issued_by: string;
  reason?: string | null;
  target_lot_id?: string | null;
  target_burst_id?: string | null;
}

const INSERT_SQL = `
  INSERT INTO control_commands (
    time, message_id, equipment_id, command, issued_by,
    reason, target_lot_id, target_burst_id
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8
  )
`;

function parsePayload(payload: Buffer): ControlCmdPayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as ControlCmdPayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'CONTROL_CMD JSON parse failed, dropping message',
    );
    return null;
  }
}

export async function insertControlCmd(
  pool: DbPool,
  equipmentId: string,
  msg: ControlCmdPayload,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    msg.timestamp,
    msg.message_id,
    equipmentId,
    msg.command,
    msg.issued_by,
    msg.reason ?? null,
    msg.target_lot_id ?? null,
    msg.target_burst_id ?? null,
  ]);
}

export async function handleControlCmd(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  // payload에 equipment_id가 있으면 일치 검증 (없으면 토픽 값 사용)
  if (msg.equipment_id && msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'CONTROL_CMD equipment_id mismatch',
    );
  }

  try {
    await insertControlCmd(getPool(), equipmentId, msg);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId,
        command: msg.command,
      },
      'CONTROL_CMD insert failed',
    );
  }
}
