import { logger } from '../utils/logger.js';

// H6에서 감사 로그 적재 구현 예정
export async function handleControlCmd(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  logger.debug(
    { equipmentId, bytes: payload.length },
    'CONTROL_CMD (handler stub)',
  );
}
