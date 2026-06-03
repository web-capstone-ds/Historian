// lot 단위 치수(geometric) 분포 스트리밍 집계 — Cpk(공정능력지수) 산출용
//
// 배경: PASS drop 정책상 geometric 컬럼은 FAIL 레코드에만 적재되지만(§3.2),
// EAP는 PASS 유닛도 geometric 값을 발행한다. Cpk는 전체(PASS+FAIL) 분포가 필요하므로
// INSPECTION_RESULT 수신 시점(적재 직전, PASS drop 무관)에 lot별 n/mean/stdev를 누적한다.
// LOT_END 시 finalize 하여 lot_ends.geometric_stats(JSONB)에 적재 후 해당 lot 누적을 정리한다.
//
// AI 서버 GEOMETRIC_METRICS(derived_stats.py)와 동일한 metric 이름/대상을 사용한다.

import { logger } from './logger.js';

export const GEOMETRIC_METRICS = [
  'dimension_w_mm',
  'dimension_l_mm',
  'dimension_h_mm',
  'kerf_width_um',
] as const;

interface MetricAccumulator {
  n: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
}

export interface MetricSummary {
  n: number;
  mean: number;
  stdev: number;
  min: number;
  max: number;
}

export type GeometricStats = Record<string, MetricSummary>;

// lot_id -> (metric -> accumulator)
const lots: Map<string, Map<string, MetricAccumulator>> = new Map();

// 진행 중 LOT 누적이 무한정 쌓이는 것을 막는 안전장치(비정상 종료/유실 LOT 대비)
const MAX_TRACKED_LOTS = 64;

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// 한 검사 유닛의 geometric 값을 해당 lot 누적에 반영. PASS/FAIL 무관 호출.
export function accumulateGeometric(lotId: string, geometric: unknown): void {
  if (!lotId || geometric === null || typeof geometric !== 'object') return;
  const values = geometric as Record<string, unknown>;

  let lot = lots.get(lotId);
  if (!lot) {
    if (lots.size >= MAX_TRACKED_LOTS) {
      // 가장 오래된 추적 LOT 제거(LOT_END 누락 등 비정상 상황 방어)
      const oldest = lots.keys().next().value;
      if (oldest !== undefined) {
        lots.delete(oldest);
        logger.warn({ evictedLotId: oldest }, 'geometric-aggregator: evicted stale lot accumulator');
      }
    }
    lot = new Map();
    lots.set(lotId, lot);
  }

  for (const metric of GEOMETRIC_METRICS) {
    const raw = values[metric];
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(v)) continue;

    let acc = lot.get(metric);
    if (!acc) {
      acc = { n: 0, sum: 0, sumSq: 0, min: v, max: v };
      lot.set(metric, acc);
    }
    acc.n += 1;
    acc.sum += v;
    acc.sumSq += v * v;
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
  }
}

// 해당 lot 누적을 n/mean/stdev(표본 표준편차)/min/max로 마감. 데이터 없으면 null.
// finalize 후 누적은 제거된다.
export function finalizeGeometric(lotId: string): GeometricStats | null {
  const lot = lots.get(lotId);
  lots.delete(lotId);
  if (!lot || lot.size === 0) return null;

  const result: GeometricStats = {};
  for (const [metric, acc] of lot) {
    if (acc.n <= 0) continue;
    const mean = acc.sum / acc.n;
    // 표본 분산: (Σx² - (Σx)²/n) / (n-1). 부동소수 오차로 음수가 되면 0으로 보정.
    const variance = acc.n > 1 ? Math.max(0, (acc.sumSq - (acc.sum * acc.sum) / acc.n) / (acc.n - 1)) : 0;
    result[metric] = {
      n: acc.n,
      mean: round(mean),
      stdev: round(Math.sqrt(variance)),
      min: round(acc.min),
      max: round(acc.max),
    };
  }
  return Object.keys(result).length > 0 ? result : null;
}

// 테스트 전용 — 운영 코드에서 호출 금지
export function _clearGeometricForTest(): void {
  lots.clear();
}
