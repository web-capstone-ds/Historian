import { describe, it, expect, vi, afterEach } from 'vitest';
import { BatchInserter } from '../../src/db/batch-inserter.js';
import type pg from 'pg';

interface Row {
  a: number;
  b: string;
}

interface FakePool {
  pool: pg.Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
}

function makeFakePool(opts?: { failFirst?: number }): FakePool {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let failures = opts?.failFirst ?? 0;
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (failures > 0) {
        failures -= 1;
        throw new Error('simulated db failure');
      }
      return { rows: [], rowCount: params.length };
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

function makeInserter(
  pool: pg.Pool,
  overrides: Partial<ConstructorParameters<typeof BatchInserter<Row>>[0]> = {},
): BatchInserter<Row> {
  return new BatchInserter<Row>({
    name: 'test',
    pool,
    size: 3,
    flushIntervalMs: 50,
    columnsPerRow: 2,
    insertPrefix: 'INSERT INTO t (a, b)',
    serializeRow: (r) => [r.a, r.b],
    ...overrides,
  });
}

describe('BatchInserter', () => {
  let activeInserter: BatchInserter<Row> | null = null;

  afterEach(async () => {
    if (activeInserter) {
      await activeInserter.stop();
      activeInserter = null;
    }
  });

  it('size 도달 시 자동 플러시 (multi-row INSERT)', async () => {
    const { pool, calls } = makeFakePool();
    const inserter = makeInserter(pool, { size: 3 });
    activeInserter = inserter;

    inserter.enqueue({ a: 1, b: 'x' });
    inserter.enqueue({ a: 2, b: 'y' });
    expect(calls.length).toBe(0); // 아직 플러시 전
    inserter.enqueue({ a: 3, b: 'z' });

    // size 도달 → void flush() 비동기 실행
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.length).toBe(1);
    const { sql, params } = calls[0]!;
    expect(sql).toBe(
      'INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4), ($5, $6)',
    );
    expect(params).toEqual([1, 'x', 2, 'y', 3, 'z']);
  });

  it('size 미달이면 flushIntervalMs 경과 시 타이머 플러시', async () => {
    const { pool, calls } = makeFakePool();
    const inserter = makeInserter(pool, { size: 100, flushIntervalMs: 30 });
    activeInserter = inserter;

    inserter.enqueue({ a: 10, b: 'aa' });
    inserter.enqueue({ a: 11, b: 'bb' });

    // 타이머 대기
    await new Promise((r) => setTimeout(r, 80));

    expect(calls.length).toBe(1);
    expect(calls[0]!.params).toEqual([10, 'aa', 11, 'bb']);
  });

  it('빈 버퍼일 때는 타이머 틱에도 쿼리 발행 없음', async () => {
    const { pool, calls } = makeFakePool();
    const inserter = makeInserter(pool, { flushIntervalMs: 30 });
    activeInserter = inserter;

    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(0);
  });

  it('플러시 실패 1회 → 재시도 성공 시 최종 적재', async () => {
    const { pool, calls } = makeFakePool({ failFirst: 1 });
    const inserter = makeInserter(pool, { size: 2 });
    activeInserter = inserter;

    inserter.enqueue({ a: 1, b: 'x' });
    inserter.enqueue({ a: 2, b: 'y' });

    await new Promise((r) => setTimeout(r, 30));

    // 1차 실패 + 2차 재시도 → pool.query가 총 2회 호출됨
    expect(calls.length).toBe(2);
    expect(calls[0]!.params).toEqual([1, 'x', 2, 'y']);
    expect(calls[1]!.params).toEqual([1, 'x', 2, 'y']);
  });

  it('플러시 실패 2회 연속 → 드롭 (OOM 방지)', async () => {
    const { pool, calls } = makeFakePool({ failFirst: 2 });
    const inserter = makeInserter(pool, { size: 2 });
    activeInserter = inserter;

    inserter.enqueue({ a: 1, b: 'x' });
    inserter.enqueue({ a: 2, b: 'y' });

    await new Promise((r) => setTimeout(r, 30));

    expect(calls.length).toBe(2); // 2회 시도 후 드롭
    // 다음 enqueue는 새 배치에만 영향 → 이전 배치는 복구되지 않음
    inserter.enqueue({ a: 3, b: 'z' });
    await new Promise((r) => setTimeout(r, 80)); // 타이머 기다림
    const last = calls[calls.length - 1]!;
    expect(last.params).toEqual([3, 'z']); // 과거 배치 포함되지 않음
  });

  it('serializeRow 길이 불일치 → 에러로 재시도→드롭', async () => {
    const { pool, calls } = makeFakePool();
    const inserter = makeInserter(pool, {
      size: 1,
      serializeRow: () => [1], // columnsPerRow=2인데 1개 반환
    });
    activeInserter = inserter;

    inserter.enqueue({ a: 99, b: 'bad' });
    await new Promise((r) => setTimeout(r, 30));

    // pool.query는 호출되지 않음 (executeBatch 내부에서 throw)
    expect(calls.length).toBe(0);
  });

  it('stop() → 잔여 버퍼 플러시 + 타이머 해제', async () => {
    const { pool, calls } = makeFakePool();
    const inserter = makeInserter(pool, { size: 100, flushIntervalMs: 10_000 });
    activeInserter = null; // afterEach에서 다시 stop 호출하지 않도록

    inserter.enqueue({ a: 1, b: 'x' });
    inserter.enqueue({ a: 2, b: 'y' });

    expect(calls.length).toBe(0);
    await inserter.stop();
    expect(calls.length).toBe(1);
    expect(calls[0]!.params).toEqual([1, 'x', 2, 'y']);

    // stop 이후 enqueue는 드롭
    inserter.enqueue({ a: 3, b: 'z' });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });

  it('동시 대량 enqueue → 배치 사이즈로 쪼개져 플러시', async () => {
    const { pool, calls } = makeFakePool();
    const inserter = makeInserter(pool, { size: 3, flushIntervalMs: 100 });
    activeInserter = inserter;

    // 7건 연속 enqueue (첫 번째 3건은 즉시 size flush 트리거)
    for (let i = 1; i <= 7; i += 1) {
      inserter.enqueue({ a: i, b: `v${i}` });
    }

    // 첫 배치 끝나기 기다림
    await new Promise((r) => setTimeout(r, 30));
    // 아직 7개 중 3개만 플러시됐을 수 있음 — 타이머 플러시 추가 대기
    await new Promise((r) => setTimeout(r, 150));

    await inserter.stop();

    const totalRows = calls.reduce((sum, c) => sum + c.params.length / 2, 0);
    expect(totalRows).toBe(7);
  });
});
