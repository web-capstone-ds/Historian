import { logger } from '../utils/logger.js';

// H5에서 PASS drop 정책 + TSDB 적재 구현 예정
export async function handleInspectionResult(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  logger.debug(
    { equipmentId, bytes: payload.length },
    'INSPECTION_RESULT (handler stub)',
  );
}
