import { logger } from '../utils/logger.js';

// H6에서 TSDB 적재 구현 예정
export async function handleOracleAnalysis(
  equipmentId: string,
  payload: Buffer,
): Promise<void> {
  logger.debug(
    { equipmentId, bytes: payload.length },
    'ORACLE_ANALYSIS (handler stub)',
  );
}
