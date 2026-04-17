import { logger } from '../utils/logger.js';
import { handleHeartbeat } from '../handlers/heartbeat.handler.js';
import { handleStatusUpdate } from '../handlers/status.handler.js';
import { handleInspectionResult } from '../handlers/inspection.handler.js';
import { handleLotEnd } from '../handlers/lot-end.handler.js';
import { handleHwAlarm } from '../handlers/alarm.handler.js';
import { handleRecipeChanged } from '../handlers/recipe.handler.js';
import { handleControlCmd } from '../handlers/control.handler.js';
import { handleOracleAnalysis } from '../handlers/oracle.handler.js';

export type MessageRoutingHandler = (
  equipmentId: string,
  payload: Buffer,
) => Promise<void>;

export type HandlerMap = Record<string, MessageRoutingHandler>;

// 작업명세서 §5.4 토픽 segment → 핸들러 매핑
export const DEFAULT_HANDLER_MAP: HandlerMap = {
  heartbeat: handleHeartbeat,
  status: handleStatusUpdate,
  result: handleInspectionResult,
  lot: handleLotEnd,
  alarm: handleHwAlarm,
  recipe: handleRecipeChanged,
  control: handleControlCmd,
  oracle: handleOracleAnalysis,
};

export interface ParsedTopic {
  equipmentId: string;
  segment: string;
}

// 토픽 형식: ds/{equipment_id}/{segment}
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'ds') return null;
  const equipmentId = parts[1];
  const segment = parts[2];
  if (!equipmentId || !segment) return null;
  return { equipmentId, segment };
}

export async function routeMessage(
  topic: string,
  payload: Buffer,
  handlerMap: HandlerMap = DEFAULT_HANDLER_MAP,
): Promise<void> {
  // §5.5 빈 페이로드는 ALARM_ACK retained clear 신호 — 라우팅 없이 무시
  if (payload.length === 0) {
    logger.debug({ topic }, 'Empty payload, skipping (retained clear)');
    return;
  }

  const parsed = parseTopic(topic);
  if (!parsed) {
    logger.warn({ topic }, 'Unrecognized topic pattern, ignoring');
    return;
  }

  const handler = handlerMap[parsed.segment];
  if (!handler) {
    logger.warn(
      { topic, segment: parsed.segment, equipmentId: parsed.equipmentId },
      'No handler for topic segment, ignoring',
    );
    return;
  }

  try {
    await handler(parsed.equipmentId, payload);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        topic,
        equipmentId: parsed.equipmentId,
      },
      'Handler threw, continuing',
    );
  }
}
