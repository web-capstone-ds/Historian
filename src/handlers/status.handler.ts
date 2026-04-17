import { logger } from '../utils/logger.js';

// H6/H11에서 TSDB 적재 + equipment-cache 갱신 구현 예정
export async function handleStatusUpdate(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  logger.debug(
    { equipmentId, bytes: payload.length },
    'STATUS_UPDATE (handler stub)',
  );
}
