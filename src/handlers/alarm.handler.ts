import { logger } from '../utils/logger.js';

// H6에서 TSDB 적재 구현 예정 (빈 페이로드는 라우터에서 사전 필터링)
export async function handleHwAlarm(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  logger.debug(
    { equipmentId, bytes: payload.length },
    'HW_ALARM (handler stub)',
  );
}
