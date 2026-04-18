import { logger } from '../utils/logger.js';
import { getPool, type DbPool } from '../db/pool.js';

export interface RecipeChangedPayload {
  message_id: string;
  event_type: 'RECIPE_CHANGED';
  timestamp: string;
  equipment_id: string;
  equipment_status: string;
  previous_recipe_id: string;
  previous_recipe_version: string;
  new_recipe_id: string;
  new_recipe_version: string;
  changed_by: string;
}

const INSERT_SQL = `
  INSERT INTO recipe_changes (
    time, message_id, equipment_id, equipment_status,
    previous_recipe_id, previous_recipe_version,
    new_recipe_id, new_recipe_version, changed_by
  ) VALUES (
    $1, $2, $3, $4,
    $5, $6,
    $7, $8, $9
  )
`;

function parsePayload(payload: Buffer): RecipeChangedPayload | null {
  try {
    return JSON.parse(payload.toString('utf8')) as RecipeChangedPayload;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'RECIPE_CHANGED JSON parse failed, dropping message',
    );
    return null;
  }
}

export async function insertRecipeChanged(
  pool: DbPool,
  msg: RecipeChangedPayload,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    msg.timestamp,
    msg.message_id,
    msg.equipment_id,
    msg.equipment_status,
    msg.previous_recipe_id,
    msg.previous_recipe_version,
    msg.new_recipe_id,
    msg.new_recipe_version,
    msg.changed_by,
  ]);
}

export async function handleRecipeChanged(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  const msg = parsePayload(payload);
  if (!msg) return;

  if (msg.equipment_id !== equipmentId) {
    logger.warn(
      { topicEq: equipmentId, payloadEq: msg.equipment_id },
      'RECIPE_CHANGED equipment_id mismatch',
    );
  }

  if (msg.equipment_status !== 'IDLE') {
    // 정책상 IDLE이어야 하지만 비정상 전환 감지를 위해 적재는 그대로 진행
    logger.warn(
      {
        equipmentId: msg.equipment_id,
        equipmentStatus: msg.equipment_status,
        newRecipeId: msg.new_recipe_id,
      },
      'RECIPE_CHANGED equipment_status is not IDLE (abnormal transition)',
    );
  }

  try {
    await insertRecipeChanged(getPool(), msg);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        equipmentId: msg.equipment_id,
        newRecipeId: msg.new_recipe_id,
      },
      'RECIPE_CHANGED insert failed',
    );
  }
}
