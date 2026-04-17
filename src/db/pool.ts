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
