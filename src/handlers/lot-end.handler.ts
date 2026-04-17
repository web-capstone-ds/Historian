import { logger } from '../utils/logger.js';

// H6/H11에서 recipe_id/operator_id enrichment + TSDB 적재 구현 예정
export async function handleLotEnd(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  logger.debug(
    { equipmentId, bytes: payload.length },
    'LOT_END (handler stub)',
  );
}
