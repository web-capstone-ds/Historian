import { describe, it, expect, vi } from 'vitest';
import { gracefulShutdown, registerShutdownSignals } from '../src/shutdown.js';

function makeDeps(overrides: Partial<{
  stopBatchInserter: () => Promise<void>;
  endMqtt: () => Promise<void>;
  closeDbPool: () => Promise<void>;
}> = {}) {
  const order: string[] = [];
  const deps = {
    stopBatchInserter: vi.fn(async () => {
      order.push('batch');
    }),
    endMqtt: vi.fn(async () => {
      order.push('mqtt');
    }),
    closeDbPool: vi.fn(async () => {
      order.push('db');
    }),
    ...overrides,
  };
  return { deps, order };
}

describe('gracefulShutdown', () => {
  it('순서: batch → mqtt → db, 모두 성공 시 exit(0)', async () => {
    const { deps, order } = makeDeps();
    const exit = vi.fn();
    await gracefulShutdown('SIGINT', deps, { exit });

    expect(order).toEqual(['batch', 'mqtt', 'db']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('중간 단계 실패해도 다음 단계 계속 실행, exit(0)', async () => {
    const { deps, order } = makeDeps({
      endMqtt: vi.fn(async () => {
        order.push('mqtt-fail');
        throw new Error('mqtt disconnect error');
      }),
    });
    const exit = vi.fn();
    await gracefulShutdown('SIGTERM', deps, { exit });

    // batch 성공 → mqtt 실패 → db는 여전히 실행
    expect(deps.stopBatchInserter).toHaveBeenCalled();
    expect(deps.endMqtt).toHaveBeenCalled();
    expect(deps.closeDbPool).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('timeoutMs 초과 시 exit(1)', async () => {
    const deps = {
      stopBatchInserter: vi.fn(() => new Promise<void>(() => {})), // 영원히 대기
      endMqtt: vi.fn(async () => {}),
      closeDbPool: vi.fn(async () => {}),
    };
    const exit = vi.fn();
    await gracefulShutdown('SIGTERM', deps, { exit, timeoutMs: 30 });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('모든 단계 실패해도 끝까지 실행, exit(0)', async () => {
    const deps = {
      stopBatchInserter: vi.fn(async () => {
        throw new Error('a');
      }),
      endMqtt: vi.fn(async () => {
        throw new Error('b');
      }),
      closeDbPool: vi.fn(async () => {
        throw new Error('c');
      }),
    };
    const exit = vi.fn();
    await gracefulShutdown('SIGINT', deps, { exit });
    expect(deps.stopBatchInserter).toHaveBeenCalled();
    expect(deps.endMqtt).toHaveBeenCalled();
    expect(deps.closeDbPool).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('registerShutdownSignals', () => {
  it('SIGINT 수신 시 shutdown 실행 (단일 시그널)', async () => {
    const { deps } = makeDeps();
    const exit = vi.fn();
    registerShutdownSignals(deps, { exit, timeoutMs: 500 });

    // 시그널 발생 시뮬레이션
    process.emit('SIGINT');
    // shutdown은 async — 완료 대기
    await new Promise((r) => setTimeout(r, 30));

    expect(deps.stopBatchInserter).toHaveBeenCalled();
    expect(deps.endMqtt).toHaveBeenCalled();
    expect(deps.closeDbPool).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);

    // cleanup — 다음 테스트에 영향 없도록 리스너 제거
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('두 번째 시그널 수신 시 즉시 exit(1) 강제 종료', async () => {
    const blockingBatch = vi.fn(() => new Promise<void>(() => {})); // 영원히 대기
    const deps = {
      stopBatchInserter: blockingBatch,
      endMqtt: vi.fn(async () => {}),
      closeDbPool: vi.fn(async () => {}),
    };
    const exit = vi.fn();
    registerShutdownSignals(deps, { exit, timeoutMs: 10_000 });

    process.emit('SIGTERM'); // 1차 — shutdown 시작 (batch에서 블로킹)
    await new Promise((r) => setTimeout(r, 10));
    process.emit('SIGTERM'); // 2차 — 강제 종료
    await new Promise((r) => setTimeout(r, 10));

    expect(exit).toHaveBeenCalledWith(1);

    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });
});
