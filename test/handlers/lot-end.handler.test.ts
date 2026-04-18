import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  enrichLotEnd,
  insertLotEnd,
  handleLotEnd,
  type LotEndPayload,
} from '../../src/handlers/lot-end.handler.js';
import { handleStatusUpdate } from '../../src/handlers/status.handler.js';
import { _setPoolForTest } from '../../src/db/pool.js';
import { _clearCacheForTest, upsertStatus } from '../../src/utils/equipment-cache.js';
import type pg from 'pg';

const MOCK_DIR = resolve(import.meta.dirname, '../../../DS-Document/EAP_mock_data');

function loadBuffer(name: string): Buffer {
  return readFileSync(resolve(MOCK_DIR, name));
}

function loadJson<T>(name: string): T {
  return JSON.parse(loadBuffer(name).toString('utf8')) as T;
}

function makeFakePool(): {
  pool: pg.Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe('enrichLotEnd — STATUS 캐시 조회', () => {
  beforeEach(() => {
    _clearCacheForTest();
  });

  it('캐시 hit → recipe_id/operator_id 주입 + enriched=true', () => {
    upsertStatus('DS-VIS-001', { recipe_id: 'Carsem_3X3', operator_id: 'ENG-KIM' });
    const result = enrichLotEnd('DS-VIS-001');
    expect(result).toEqual({
      recipe_id: 'Carsem_3X3',
      operator_id: 'ENG-KIM',
      enriched: true,
    });
  });

  it('캐시 miss → UNKNOWN 폴백 + enriched=false', () => {
    const result = enrichLotEnd('DS-VIS-999');
    expect(result).toEqual({
      recipe_id: 'UNKNOWN',
      operator_id: 'UNKNOWN',
      enriched: false,
    });
  });
});

describe('insertLotEnd — Mock 09 (정상 종료)', () => {
  it('enrichment 결과를 SQL 파라미터에 주입', async () => {
    const msg = loadJson<LotEndPayload>('09_lot_end_normal.json');
    const { pool, calls } = makeFakePool();

    await insertLotEnd(pool, msg, {
      recipe_id: 'Carsem_3X3',
      operator_id: 'ENG-KIM',
      enriched: true,
    });

    const params = calls[0]!.params;
    expect(params[0]).toBe('2026-01-22T17:39:13.646Z'); // time 원본 유지
    expect(params[3]).toBe('LOT-20260122-001'); // lot_id
    expect(params[4]).toBe('COMPLETED'); // lot_status
    expect(params[5]).toBe('Carsem_3X3'); // recipe_id (enrichment)
    expect(params[6]).toBe('ENG-KIM'); // operator_id (enrichment)
    expect(params[7]).toBe(2792); // total_units
    expect(params[10]).toBe(96.2); // yield_pct
    expect(params[11]).toBe(4923); // lot_duration_sec
  });
});

describe('handleLotEnd — STATUS → LOT_END 시퀀스 엔드투엔드', () => {
  beforeEach(() => {
    _clearCacheForTest();
    _setPoolForTest(null);
  });

  it('STATUS_UPDATE 수신 → LOT_END 수신 시 캐시 값 주입', async () => {
    const { pool, calls } = makeFakePool();
    _setPoolForTest(pool);

    // 1) STATUS_UPDATE 먼저 수신 (캐시 갱신)
    const status = loadBuffer('02_status_run.json');
    await handleStatusUpdate('DS-VIS-001', status);

    // 2) LOT_END 수신 (캐시에서 enrichment)
    const lotEnd = loadBuffer('09_lot_end_normal.json');
    await handleLotEnd('DS-VIS-001', lotEnd);

    // 2건 INSERT: status_updates + lot_ends
    expect(calls.length).toBe(2);

    // 2번째 INSERT가 lot_ends
    const lotParams = calls[1]!.params;
    expect(lotParams[3]).toBe('LOT-20260122-001');
    expect(lotParams[5]).toBe('Carsem_3X3'); // STATUS 캐시에서 주입
    expect(lotParams[6]).toBe('ENG-KIM');
  });

  it('STATUS 없이 LOT_END 수신 → UNKNOWN 적재', async () => {
    const { pool, calls } = makeFakePool();
    _setPoolForTest(pool);

    const lotEnd = loadBuffer('09_lot_end_normal.json');
    await handleLotEnd('DS-VIS-001', lotEnd);

    expect(calls.length).toBe(1);
    const params = calls[0]!.params;
    expect(params[5]).toBe('UNKNOWN');
    expect(params[6]).toBe('UNKNOWN');
  });

  it('4대 장비 — 각 장비 STATUS가 다른 장비 LOT_END에 영향 없음', async () => {
    const { pool, calls } = makeFakePool();
    _setPoolForTest(pool);

    // 4대 장비 각각 서로 다른 recipe로 STATUS 등록
    upsertStatus('DS-VIS-001', { recipe_id: 'Carsem_3X3', operator_id: 'ENG-KIM' });
    upsertStatus('DS-VIS-002', { recipe_id: 'Carsem_4X6', operator_id: 'ENG-LEE' });
    upsertStatus('DS-VIS-003', { recipe_id: 'ATC_1X1', operator_id: 'ENG-PARK' });
    upsertStatus('DS-VIS-004', { recipe_id: '446275', operator_id: 'ENG-CHOI' });

    // DS-VIS-002의 LOT_END 수신 — 페이로드 equipment_id가 DS-VIS-001이지만
    // 토픽 equipmentId는 payload 기준으로 캐시 조회 (payload.equipment_id 사용)
    const payload = loadJson<LotEndPayload>('09_lot_end_normal.json');
    // 페이로드 equipment_id를 002로 override
    const modified = JSON.stringify({ ...payload, equipment_id: 'DS-VIS-002' });

    await handleLotEnd('DS-VIS-002', Buffer.from(modified));

    expect(calls.length).toBe(1);
    const params = calls[0]!.params;
    expect(params[2]).toBe('DS-VIS-002'); // equipment_id
    expect(params[5]).toBe('Carsem_4X6'); // 002의 recipe
    expect(params[6]).toBe('ENG-LEE'); // 002의 operator
  });

  it('JSON 파싱 실패 → 크래시 없음, 적재 없음', async () => {
    const { pool, calls } = makeFakePool();
    _setPoolForTest(pool);

    await expect(
      handleLotEnd('DS-VIS-001', Buffer.from('not-json{')),
    ).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
  });
});
