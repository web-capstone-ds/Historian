// 재연결 백오프 (작업명세서 §5.3, 절대 금지 사항 §14: 수열 변경 금지)
// 수열: 1s → 2s → 5s → 15s → 30s → 60s (이후 60s 유지), jitter ±20%

export const BACKOFF_SECONDS: readonly number[] = [1, 2, 5, 15, 30, 60];
const JITTER_RATIO = 0.2;

export function getBackoffDelayMs(
  attempt: number,
  rng: () => number = Math.random,
): number {
  const idx = Math.min(Math.max(attempt, 0), BACKOFF_SECONDS.length - 1);
  const baseSec = BACKOFF_SECONDS[idx]!;
  const jitter = baseSec * JITTER_RATIO * (rng() * 2 - 1);
  return (baseSec + jitter) * 1000;
}
