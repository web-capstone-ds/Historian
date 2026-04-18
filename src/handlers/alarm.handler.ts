import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';

// HW_ALARM — burst_id / burst_count / lot_id는 선택적. payload_raw에 원본 전체 보존.
export interface HwAlarmPayload {
  message_id: string;
  event_type: 'HW_ALARM';
  timestamp: string;
  equipment_id: string;
  equipment_status: string;
  alarm_level: string;
  hw_error_code: string;
  hw_error_source: string;
  hw_error_detail: string;
  exception_detail: unknown | null;
  auto_recovery_attempted: boolean;
  requires_manual_intervention: boolean;
  burst_id?: string | null;
  burst_count?: number | null;
  lot_id?: string | null;
}

const INSERT_SQL = `
  INSERT INTO hw_alarms (
    time, message_id, equipment_id, equipment_status,
    alarm_level, hw_error_code, hw_error_source, hw_error_detail,
    exception_detail, auto_recovery_attempted, requires_manual_intervention,
    burst_id, burst_count, lot_id, payload_raw
  ) VALUES (
    $1, $2, $3, $4,
    $5, $6, $7, $8,
    $9, $10, $11,
    $12, $13, $14, $15
  )
`;

function parsePayload(payload: Buffer): { msg: HwAlarmPayload; raw: string } | null {
  try {
    const text = payload.toString('utf8');
    const msg = JSON.parse(text) as HwAlarmPayload;
    return { msg, raw: text };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'HW_ALARM JSON parse failed, dropping message',
    );
    return null;
  }
}

export async function insertHwAlarm(
  pool: DbPool,
  msg: HwAlarmPayload,
  rawJson: string,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    msg.timestamp,
    msg.message_id,
    msg.equipment_id,
    msg.equipment_status,
    msg.alarm_level,
    msg.hw_error_code,
    msg.hw_error_source,
    msg.hw_error_detail,
    msg.exception_detail == null ? null : JSON.stringify(msg.exception_detail),
    msg.auto_recovery_attempted,
    msg.requires_manual_intervention,
    msg.burst_id ?? null,
    msg.burst_count ?? null,
    msg.lot_id ?? null,
    rawJson,
  ]);
}

export async function handleHwAlarm(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const parsed = parsePayload(payload);
  if (!parsed) return;
  const { msg, raw } = parsed;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'HW_ALARM equipment_id mismatch',
    );
  }

  try {
    await insertHwAlarm(getPool(), msg, raw);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
        hwErrorCode: msg.hw_error_code,
      },
      'HW_ALARM insert failed',
    );
  }
}
