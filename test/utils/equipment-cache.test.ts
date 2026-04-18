import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertStatus,
  getStatus,
  _clearCacheForTest,
} from '../../src/utils/equipment-cache.js';

describe('equipment-cache', () => {
  beforeEach(() => {
    _clearCacheForTest();
  });

  it('upsert 후 getStatus로 동일 스냅샷 조회', () => {
    upsertStatus('DS-VIS-001', { recipe_id: 'Carsem_3X3', operator_id: 'ENG-KIM' });
    expect(getStatus('DS-VIS-001')).toEqual({
      recipe_id: 'Carsem_3X3',
      operator_id: 'ENG-KIM',
    });
  });

  it('미존재 장비 조회 → undefined', () => {
    expect(getStatus('DS-VIS-999')).toBeUndefined();
  });

  it('같은 장비에 대한 재upsert는 최신 값으로 덮어씀', () => {
    upsertStatus('DS-VIS-001', { recipe_id: 'ATC_1X1', operator_id: 'ENG-KIM' });
    upsertStatus('DS-VIS-001', { recipe_id: 'Carsem_4X6', operator_id: 'ENG-LEE' });
    expect(getStatus('DS-VIS-001')).toEqual({
      recipe_id: 'Carsem_4X6',
      operator_id: 'ENG-LEE',
    });
  });

  it('4대 장비 독립 유지 — 한 장비 갱신이 다른 장비에 영향 없음', () => {
    upsertStatus('DS-VIS-001', { recipe_id: 'Carsem_3X3', operator_id: 'ENG-KIM' });
    upsertStatus('DS-VIS-002', { recipe_id: 'Carsem_4X6', operator_id: 'ENG-LEE' });
    upsertStatus('DS-VIS-003', { recipe_id: 'ATC_1X1', operator_id: 'ENG-PARK' });
    upsertStatus('DS-VIS-004', { recipe_id: '446275', operator_id: 'ENG-CHOI' });

    upsertStatus('DS-VIS-001', { recipe_id: 'Carsem_4X6', operator_id: 'ENG-KIM' });

    expect(getStatus('DS-VIS-001')?.recipe_id).toBe('Carsem_4X6');
    expect(getStatus('DS-VIS-002')?.recipe_id).toBe('Carsem_4X6');
    expect(getStatus('DS-VIS-003')?.recipe_id).toBe('ATC_1X1');
    expect(getStatus('DS-VIS-004')?.recipe_id).toBe('446275');
    expect(getStatus('DS-VIS-002')?.operator_id).toBe('ENG-LEE');
  });
});
