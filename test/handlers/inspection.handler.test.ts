import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  insertInspectionResult,
  isPassDrop,
  handleInspectionResult,
  type InspectionPayload,
} from '../../src/handlers/inspection.handler.js';
import { _setPoolForTest } from '../../src/db/pool.js';
import type pg from 'pg';

// Mock 데이터 절대경로 — 인접 저장소(DS-Document) 참조
const MOCK_DIR = resolve(
  import.meta.dirname,
  '../../../DS-Document/EAP_mock_data',
);

function loadMock(name: string): InspectionPayload {
  const raw = readFileSync(resolve(MOCK_DIR, name), 'utf8');
  return JSON.parse(raw) as InspectionPayload;
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

describe('isPassDrop', () => {
  it('PASS + fail_count=0 → true', () => {
    const msg = loadMock('04_inspection_pass.json');
    expect(isPassDrop(msg)).toBe(true);
  });

  it('FAIL + fail_count>0 → false', () => {
    const msg = loadMock('05_inspection_fail_side_et52.json');
    expect(isPassDrop(msg)).toBe(false);
  });

  it('PASS이지만 fail_count가 0이 아닌 경계 상황 → false (안전측)', () => {
    const fake = {
      overall_result: 'PASS',
      fail_count: 1,
    } as unknown as InspectionPayload;
    expect(isPassDrop(fake)).toBe(false);
  });

  it('FAIL이지만 fail_count=0 (이론적 기형) → false', () => {
    const fake = {
      overall_result: 'FAIL',
      fail_count: 0,
    } as unknown as InspectionPayload;
    expect(isPassDrop(fake)).toBe(false);
  });
});

describe('insertInspectionResult — PASS drop 정책', () => {
  it('Mock 04 (PASS) → detail/geometric/bga/surface/singulation 컬럼 NULL', async () => {
    const msg = loadMock('04_inspection_pass.json');
    const { pool, calls } = makeFakePool();

    await insertInspectionResult(pool, msg);

    expect(calls.length).toBe(1);
    const params = calls[0]!.params;
    // 파라미터 인덱스 (0-based): 16=inspection_detail, 17=geometric, 18=bga, 19=surface, 20=singulation
    expect(params[16]).toBeNull();
    expect(params[17]).toBeNull();
    expect(params[18]).toBeNull();
    expect(params[19]).toBeNull();
    expect(params[20]).toBeNull();

    // summary + process 그룹은 정상 적재
    expect(params[0]).toBe(msg.timestamp); // time
    expect(params[1]).toBe(msg.message_id);
    expect(params[2]).toBe(msg.equipment_id);
    expect(params[3]).toBe(msg.lot_id);
    expect(params[9]).toBe('PASS'); // overall_result
    expect(params[11]).toBe(0); // fail_count
    expect(params[12]).toBe(8); // total_inspected_count
    expect(params[13]).toBe(1200); // inspection_duration_ms
    expect(params[14]).toBe(1620); // takt_time_ms
    expect(params[15]).toBe('v4.3.1'); // algorithm_version
  });
});

describe('insertInspectionResult — FAIL 전체 적재', () => {
  it('Mock 05 (FAIL ET=52 전수) → singulation 값 일치 + inspection_detail PascalCase 보존', async () => {
    const msg = loadMock('05_inspection_fail_side_et52.json');
    const { pool, calls } = makeFakePool();

    await insertInspectionResult(pool, msg);

    const params = calls[0]!.params;
    expect(params[9]).toBe('FAIL');
    expect(params[10]).toBe('SIDE_VISION_FAIL'); // fail_reason_code
    expect(params[11]).toBe(8); // fail_count

    // JSONB 컬럼은 JSON 문자열로 직렬화
    const singulation = JSON.parse(params[20] as string) as {
      chipping_top_um: number;
      chipping_bottom_um: number;
      burr_height_um: number;
    };
    expect(singulation.chipping_top_um).toBe(msg.singulation!.chipping_top_um);
    expect(singulation.burr_height_um).toBe(msg.singulation!.burr_height_um);

    // PascalCase 보존 확인
    const detail = JSON.parse(params[16] as string) as {
      prs_result: Array<Record<string, number>>;
      side_result: Array<Record<string, number>>;
    };
    expect(detail.prs_result[0]).toHaveProperty('ZAxisNum');
    expect(detail.prs_result[0]).toHaveProperty('InspectionResult');
    expect(detail.prs_result[0]).toHaveProperty('ErrorType');
    expect(detail.prs_result[0]).toHaveProperty('XOffset');
    expect(detail.prs_result[0]).toHaveProperty('YOffset');
    expect(detail.prs_result[0]).toHaveProperty('TOffset');
    // snake_case로 변환되지 않음을 명시적으로 확인
    expect(detail.prs_result[0]).not.toHaveProperty('z_axis_num');
    expect(detail.side_result[0]!.ErrorType).toBe(52);
  });

  it('Mock 06 (FAIL ET=12 전수) → inspection_detail PascalCase 유지', async () => {
    const msg = loadMock('06_inspection_fail_side_et12.json');
    const { pool, calls } = makeFakePool();

    await insertInspectionResult(pool, msg);

    const params = calls[0]!.params;
    expect(params[10]).toBe('CHIPPING_EXCEED');
    const detail = JSON.parse(params[16] as string) as {
      side_result: Array<{ ZAxisNum: number; ErrorType: number }>;
    };
    expect(detail.side_result[0]!.ErrorType).toBe(12);
    expect(detail.side_result[7]!.ZAxisNum).toBe(7);
  });

  it('Mock 07 (FAIL ET=11 PRS 3/8) → total_inspected_count / fail_count 일치', async () => {
    const msg = loadMock('07_inspection_fail_prs_offset.json');
    const { pool, calls } = makeFakePool();

    await insertInspectionResult(pool, msg);

    const params = calls[0]!.params;
    expect(params[10]).toBe('DIMENSION_OUT_OF_SPEC');
    expect(params[11]).toBe(3);
    expect(params[12]).toBe(8);

    const detail = JSON.parse(params[16] as string) as {
      prs_result: Array<{ ErrorType: number; XOffset: number }>;
    };
    // ZAxisNum=0 → ET=11, XOffset=73 (원본 실측값 보존)
    expect(detail.prs_result[0]!.ErrorType).toBe(11);
    expect(detail.prs_result[0]!.XOffset).toBe(73);
  });

  it('Mock 08 (FAIL ET=52+12 혼재) → inspection_detail 혼재 패턴 보존', async () => {
    const msg = loadMock('08_inspection_fail_side_mixed.json');
    const { pool, calls } = makeFakePool();

    await insertInspectionResult(pool, msg);

    const params = calls[0]!.params;
    expect(params[10]).toBe('SIDE_VISION_FAIL');
    expect(params[11]).toBe(6);

    const detail = JSON.parse(params[16] as string) as {
      side_result: Array<{ ZAxisNum: number; ErrorType: number }>;
    };
    // ZA=1 ET=52, ZA=4 ET=12 혼재
    expect(detail.side_result[1]!.ErrorType).toBe(52);
    expect(detail.side_result[4]!.ErrorType).toBe(12);
  });
});

describe('insertInspectionResult — timestamp 원본 보존', () => {
  it('원본 ISO 8601 문자열을 Date.now()로 치환하지 않음', async () => {
    const msg = loadMock('04_inspection_pass.json');
    const { pool, calls } = makeFakePool();

    await insertInspectionResult(pool, msg);
    expect(calls[0]!.params[0]).toBe('2026-01-22T16:41:42.123Z');
  });
});

describe('handleInspectionResult — 엔드투엔드', () => {
  beforeEach(() => {
    _setPoolForTest(null);
  });

  it('JSON 파싱 실패 페이로드 → 크래시 없음, 적재 없음', async () => {
    const { pool, calls } = makeFakePool();
    _setPoolForTest(pool);
    await expect(
      handleInspectionResult('DS-VIS-001', Buffer.from('not-json{')),
    ).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it('DB query throw → 상위 크래시 없음', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as pg.Pool;
    _setPoolForTest(pool);

    const msg = loadMock('04_inspection_pass.json');
    await expect(
      handleInspectionResult(
        'DS-VIS-001',
        Buffer.from(JSON.stringify(msg)),
      ),
    ).resolves.toBeUndefined();
  });

  it('Mock 04 페이로드 → INSERT 1회 + PASS drop 적용', async () => {
    const { pool, calls } = makeFakePool();
    _setPoolForTest(pool);

    const msg = loadMock('04_inspection_pass.json');
    await handleInspectionResult(
      'DS-VIS-001',
      Buffer.from(JSON.stringify(msg)),
    );

    expect(calls.length).toBe(1);
    const params = calls[0]!.params;
    expect(params[16]).toBeNull(); // inspection_detail
    expect(params[20]).toBeNull(); // singulation
  });
});
