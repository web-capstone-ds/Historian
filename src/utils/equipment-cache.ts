// 장비별 STATUS_UPDATE 최종값 캐시 — LOT_END enrichment용 (H11에서 정식 채움)
// 여기서는 인터페이스만 선언. handleStatusUpdate가 upsertStatus를, handleLotEnd가 getStatus를 호출.

export interface CachedEquipmentStatus {
  recipe_id: string;
  operator_id: string;
}

const cache: Map<string, CachedEquipmentStatus> = new Map();

export function upsertStatus(
  equipmentId: string,
  snapshot: CachedEquipmentStatus,
): void {
  cache.set(equipmentId, snapshot);
}

export function getStatus(
  equipmentId: string,
): CachedEquipmentStatus | undefined {
  return cache.get(equipmentId);
}

// 테스트 전용 — 운영 코드에서 호출 금지
export function _clearCacheForTest(): void {
  cache.clear();
}
