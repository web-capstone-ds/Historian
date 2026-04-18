import pg from 'pg';
import type { HistorianEnv } from '../config/env.js';

const { Pool } = pg;
export type DbPool = pg.Pool;

export function createPool(env: HistorianEnv): DbPool {
  return new Pool({
    host: env.tsdb.host,
    port: env.tsdb.port,
    database: env.tsdb.database,
    user: env.tsdb.user,
    password: env.tsdb.password,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

let poolSingleton: DbPool | null = null;

export function initPool(env: HistorianEnv): DbPool {
  if (poolSingleton) return poolSingleton;
  poolSingleton = createPool(env);
  return poolSingleton;
}

export function getPool(): DbPool {
  if (!poolSingleton) {
    throw new Error('DB pool not initialized. Call initPool(env) at bootstrap.');
  }
  return poolSingleton;
}

export async function closePool(): Promise<void> {
  if (poolSingleton) {
    await poolSingleton.end();
    poolSingleton = null;
  }
}

// 테스트용 주입 — 운영 코드에서 사용 금지
export function _setPoolForTest(pool: DbPool | null): void {
  poolSingleton = pool;
}
