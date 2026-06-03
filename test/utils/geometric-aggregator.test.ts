import { describe, it, expect, beforeEach } from 'vitest';
import {
  accumulateGeometric,
  finalizeGeometric,
  _clearGeometricForTest,
} from '../../src/utils/geometric-aggregator.js';

describe('geometric-aggregator — lot 단위 치수 분포 집계', () => {
  beforeEach(() => {
    _clearGeometricForTest();
  });

  it('PASS+FAIL 전 유닛 누적 → n/mean/stdev/min/max 산출', () => {
    accumulateGeometric('LOT-A', { dimension_w_mm: 10.0 });
    accumulateGeometric('LOT-A', { dimension_w_mm: 10.02 });
    accumulateGeometric('LOT-A', { dimension_w_mm: 9.98 });

    const stats = finalizeGeometric('LOT-A');
    expect(stats).not.toBeNull();
    const w = stats!.dimension_w_mm;
    expect(w.n).toBe(3);
    expect(w.mean).toBeCloseTo(10.0, 4);
    // 표본 표준편차 = sqrt(((10-10)^2+(10.02-10)^2+(9.98-10)^2)/2) = 0.02
    expect(w.stdev).toBeCloseTo(0.02, 4);
    expect(w.min).toBe(9.98);
    expect(w.max).toBe(10.02);
  });

  it('여러 metric 독립 집계, 값 없는 metric은 제외', () => {
    accumulateGeometric('LOT-B', { dimension_w_mm: 10.0, kerf_width_um: 52.0 });
    accumulateGeometric('LOT-B', { dimension_w_mm: 10.0, kerf_width_um: 52.4 });

    const stats = finalizeGeometric('LOT-B')!;
    expect(Object.keys(stats).sort()).toEqual(['dimension_w_mm', 'kerf_width_um']);
    expect(stats.dimension_l_mm).toBeUndefined();
    expect(stats.kerf_width_um.n).toBe(2);
  });

  it('n=1 → stdev=0', () => {
    accumulateGeometric('LOT-C', { dimension_w_mm: 10.0 });
    const stats = finalizeGeometric('LOT-C')!;
    expect(stats.dimension_w_mm.n).toBe(1);
    expect(stats.dimension_w_mm.stdev).toBe(0);
  });

  it('비수치/누락 geometric은 무시', () => {
    accumulateGeometric('LOT-D', null);
    accumulateGeometric('LOT-D', undefined);
    accumulateGeometric('LOT-D', { dimension_w_mm: 'NaN' });
    expect(finalizeGeometric('LOT-D')).toBeNull();
  });

  it('finalize는 lot 누적을 정리 → 재호출 시 null', () => {
    accumulateGeometric('LOT-E', { dimension_w_mm: 10.0 });
    expect(finalizeGeometric('LOT-E')).not.toBeNull();
    expect(finalizeGeometric('LOT-E')).toBeNull();
  });

  it('서로 다른 lot은 독립 집계', () => {
    accumulateGeometric('LOT-F', { dimension_w_mm: 10.0 });
    accumulateGeometric('LOT-G', { dimension_w_mm: 12.0 });
    expect(finalizeGeometric('LOT-F')!.dimension_w_mm.mean).toBe(10.0);
    expect(finalizeGeometric('LOT-G')!.dimension_w_mm.mean).toBe(12.0);
  });
});
