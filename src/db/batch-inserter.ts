import { logger } from '../utils/logger.js';
import type { DbPool } from './pool.js';

export interface BatchInserterOptions<T> {
  name: string;
  pool: DbPool;
  size: number;
  flushIntervalMs: number;
  // COLUMN 개수 (한 행의 파라미터 개수)
  columnsPerRow: number;
  // 스키마: "INSERT INTO table (a,b,c) VALUES" 까지. VALUES 뒤는 붙지 않음.
  insertPrefix: string;
  // 한 행을 파라미터 배열로 직렬화 — 길이는 columnsPerRow와 일치해야 함
  serializeRow: (row: T) => unknown[];
}

// 100건 or 1초마다 multi-row INSERT로 플러시. 플러시 중 enqueue는 새 버퍼에 누적 (non-blocking).
// 플러시 실패는 1회 재시도 후 드롭 (OOM 방지).
export class BatchInserter<T> {
  private buffer: T[] = [];
  private isFlushing = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: BatchInserterOptions<T>) {
    this.timer = setInterval(() => {
      void this.flushIfDue();
    }, opts.flushIntervalMs);
    this.timer.unref?.();
  }

  enqueue(row: T): void {
    if (this.stopped) {
      logger.warn(
        { inserter: this.opts.name },
        'enqueue called after stop, dropping row',
      );
      return;
    }
    this.buffer.push(row);
    if (this.buffer.length >= this.opts.size && !this.isFlushing) {
      void this.flush();
    }
  }

  private async flushIfDue(): Promise<void> {
    if (this.isFlushing) return;
    if (this.buffer.length === 0) return;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.isFlushing) return;
    if (this.buffer.length === 0) return;

    // swap — 이후 enqueue는 새 버퍼로 들어감
    const batch = this.buffer;
    this.buffer = [];
    this.isFlushing = true;

    try {
      await this.executeBatch(batch);
    } catch (err) {
      logger.warn(
        {
          inserter: this.opts.name,
          size: batch.length,
          err: err instanceof Error ? err.message : String(err),
        },
        'batch flush failed, retrying once',
      );
      try {
        await this.executeBatch(batch);
      } catch (err2) {
        logger.error(
          {
            inserter: this.opts.name,
            size: batch.length,
            err: err2 instanceof Error ? err2.message : String(err2),
          },
          'batch flush failed after retry, dropping rows to prevent OOM',
        );
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private async executeBatch(batch: T[]): Promise<void> {
    const { columnsPerRow, insertPrefix, serializeRow } = this.opts;
    const params: unknown[] = [];
    const rowPlaceholders: string[] = [];

    for (let i = 0; i < batch.length; i += 1) {
      const row = batch[i]!;
      const rowParams = serializeRow(row);
      if (rowParams.length !== columnsPerRow) {
        throw new Error(
          `serializeRow length mismatch: expected ${columnsPerRow}, got ${rowParams.length}`,
        );
      }
      const base = i * columnsPerRow;
      const placeholders = rowParams
        .map((_, j) => `$${base + j + 1}`)
        .join(', ');
      rowPlaceholders.push(`(${placeholders})`);
      params.push(...rowParams);
    }

    const sql = `${insertPrefix} VALUES ${rowPlaceholders.join(', ')}`;
    await this.opts.pool.query(sql, params);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 대기 중 flush가 있다면 기다린 뒤 한 번 더 flush (잔여 드레인)
    while (this.isFlushing) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await this.flush();
  }

  // 테스트 전용
  _bufferSize(): number {
    return this.buffer.length;
  }

  _isFlushing(): boolean {
    return this.isFlushing;
  }
}
