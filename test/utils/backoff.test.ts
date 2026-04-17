import { describe, it, expect } from 'vitest';
import { getBackoffDelayMs, BACKOFF_SECONDS } from '../../src/utils/backoff.js';

describe('getBackoffDelayMs', () => {
  it('jitter 0 (rng=0.5) → 기본 수열 1,2,5,15,30,60초 반환', () => {
    const rng = () => 0.5; // (0.5 * 2 - 1) = 0 → jitter 0
    expect(getBackoffDelayMs(0, rng)).toBe(1000);
    expect(getBackoffDelayMs(1, rng)).toBe(2000);
    expect(getBackoffDelayMs(2, rng)).toBe(5000);
    expect(getBackoffDelayMs(3, rng)).toBe(15000);
    expect(getBackoffDelayMs(4, rng)).toBe(30000);
    expect(getBackoffDelayMs(5, rng)).toBe(60000);
  });

  it('attempt ≥ 수열 길이는 60초 유지 (clamp)', () => {
    const rng = () => 0.5;
    expect(getBackoffDelayMs(6, rng)).toBe(60000);
    expect(getBackoffDelayMs(100, rng)).toBe(60000);
  });

  it('음수 attempt는 0으로 clamp', () => {
    const rng = () => 0.5;
    expect(getBackoffDelayMs(-1, rng)).toBe(1000);
    expect(getBackoffDelayMs(-999, rng)).toBe(1000);
  });

  it('jitter ±20% 범위 내로 변동', () => {
    // rng=0 → -20%, rng=1 → +20%
    expect(getBackoffDelayMs(0, () => 0)).toBeCloseTo(800, -1);
    expect(getBackoffDelayMs(0, () => 1)).toBeCloseTo(1200, -1);
    expect(getBackoffDelayMs(5, () => 0)).toBeCloseTo(48_000, -2);
    expect(getBackoffDelayMs(5, () => 1)).toBeCloseTo(72_000, -2);
  });

  it('동일 attempt 반복 호출 시 jitter로 값이 변동 (기본 rng)', () => {
    const samples = Array.from({ length: 50 }, () => getBackoffDelayMs(2));
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(1);
    // 5초 기준 ±20% → [4000, 6000]
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThanOrEqual(6000);
    }
  });

  it('BACKOFF_SECONDS 수열은 [1,2,5,15,30,60] 고정 (절대 금지 사항 §14)', () => {
    expect([...BACKOFF_SECONDS]).toEqual([1, 2, 5, 15, 30, 60]);
  });
});
