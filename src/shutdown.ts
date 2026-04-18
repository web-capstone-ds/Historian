import { logger } from './utils/logger.js';

export interface ShutdownDeps {
  // 작업명세서 §12 순서: 배치 플러시 → MQTT 해제 → DB 풀 해제
  stopBatchInserter: () => Promise<void>;
  endMqtt: () => Promise<void>;
  closeDbPool: () => Promise<void>;
}

export interface ShutdownOptions {
  timeoutMs?: number;
  // 테스트용 훅 — 기본은 process.exit
  exit?: (code: number) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;

async function runStep(
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), step: label },
      'Shutdown step failed, continuing',
    );
  }
}

// 순차 실행하되 각 단계의 실패는 삼켜 다음 단계를 보장.
// 전체가 timeoutMs 내에 끝나지 않으면 exit(1).
export async function gracefulShutdown(
  signal: string,
  deps: ShutdownDeps,
  options: ShutdownOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  logger.info({ signal, timeoutMs }, 'Graceful shutdown started');

  const shutdownWork = (async () => {
    await runStep('batch-inserter', deps.stopBatchInserter);
    await runStep('mqtt', deps.endMqtt);
    await runStep('db-pool', deps.closeDbPool);
  })();

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    t.unref?.();
  });

  const winner = await Promise.race([
    shutdownWork.then(() => 'done' as const),
    timeoutPromise,
  ]);

  if (winner === 'timeout') {
    logger.error(
      { signal, timeoutMs },
      'Shutdown exceeded timeout, forcing exit(1)',
    );
    exit(1);
    return;
  }

  logger.info({ signal }, 'Graceful shutdown complete, exit(0)');
  exit(0);
}

// SIGINT/SIGTERM 등록 유틸 — 중복 시그널은 강제 종료 유도
export function registerShutdownSignals(
  deps: ShutdownDeps,
  options: ShutdownOptions = {},
): void {
  let started = false;
  const handler = (signal: string): void => {
    if (started) {
      logger.warn({ signal }, 'Second signal received, forcing exit(1)');
      (options.exit ?? ((code: number) => process.exit(code)))(1);
      return;
    }
    started = true;
    void gracefulShutdown(signal, deps, options);
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
