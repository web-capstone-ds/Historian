import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { HistorianEnv } from '../../src/config/env.js';

// mqtt 모듈 모킹 — 실제 브로커 없이 이벤트 플로우 검증
const connectMock = vi.fn();
vi.mock('mqtt', () => ({
  default: { connect: (...args: unknown[]) => connectMock(...args) },
  connect: (...args: unknown[]) => connectMock(...args),
}));

// 모킹된 fake client 생성기
interface FakeMqttClient extends EventEmitter {
  subscribe: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeMqttClient {
  const ee = new EventEmitter() as FakeMqttClient;
  ee.subscribe = vi.fn((_topic, _opts, cb) => {
    // subscribe 콜백 성공 즉시 호출 (granted 배열 흉내)
    if (typeof cb === 'function') cb(null, [{ topic: _topic, qos: _opts?.qos ?? 1 }]);
  });
  ee.reconnect = vi.fn();
  ee.end = vi.fn((_force, _opts, cb) => {
    if (typeof cb === 'function') cb();
  });
  return ee;
}

function makeEnv(): HistorianEnv {
  return {
    mqtt: {
      brokerUrl: 'mqtt://localhost:1883',
      clientId: 'test_historian',
      username: 'historian',
      password: 'secret',
    },
    db: {
      host: 'localhost',
      port: 5432,
      database: 'x',
      user: 'x',
      password: 'x',
      poolMax: 10,
    },
    batch: { size: 100, flushIntervalMs: 1000 },
    log: { level: 'info' },
  } as HistorianEnv;
}

// HistorianMqttClient는 vi.mock('mqtt')가 선언된 후 import 되어야 함
async function loadClient() {
  return await import('../../src/mqtt/client.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  connectMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HistorianMqttClient.connect — 연결 옵션', () => {
  it('명세서 §5.1 연결 옵션 그대로 mqtt.connect 호출', async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
    const [url, opts] = connectMock.mock.calls[0]!;
    expect(url).toBe('mqtt://localhost:1883');
    expect(opts).toMatchObject({
      clientId: 'test_historian',
      username: 'historian',
      password: 'secret',
      clean: false, // 세션 유지 (CLAUDE.md §1.2.2)
      keepalive: 60,
      protocolVersion: 5,
      reconnectPeriod: 0, // 내장 재연결 비활성화 (커스텀 백오프 사용)
      resubscribe: false, // 수동 재구독
      connectTimeout: 10_000,
    });
    expect(opts.properties).toEqual({ sessionExpiryInterval: 3600 });
  });

  it('두 번째 connect() 호출은 무시 (중복 초기화 방지)', async () => {
    connectMock.mockReturnValue(makeFakeClient());
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();
    client.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});

describe('HistorianMqttClient — 구독 복원', () => {
  it("'connect' 이벤트 발생 시 8종 토픽 개별 QoS로 subscribe", async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();
    fake.emit('connect');

    expect(fake.subscribe).toHaveBeenCalledTimes(8);
    const callTopicQos = fake.subscribe.mock.calls.map(([t, o]) => [t, o.qos]);
    expect(callTopicQos).toEqual([
      ['ds/+/heartbeat', 1],
      ['ds/+/status', 1],
      ['ds/+/result', 1],
      ['ds/+/lot', 2],
      ['ds/+/alarm', 2],
      ['ds/+/recipe', 2],
      ['ds/+/control', 2],
      ['ds/+/oracle', 2],
    ]);
  });
});

describe('HistorianMqttClient — 재연결 백오프', () => {
  it("'close' → 백오프 지연 후 mqtt client.reconnect() 호출", async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();

    // 첫 연결 실패 시나리오: close 이벤트 발생
    fake.emit('close');

    // 백오프 [1,2,5,15,30,60] 중 첫 단계는 최대 1.2s (+jitter 20%)
    // 중간 구간에서는 reconnect 호출 안 됨
    vi.advanceTimersByTime(500);
    expect(fake.reconnect).not.toHaveBeenCalled();

    // 1.2s 이상 경과 → 타이머 발화
    vi.advanceTimersByTime(1200);
    expect(fake.reconnect).toHaveBeenCalledTimes(1);
  });

  it('두 번째 close 동안 타이머 중복 예약 안 됨', async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();

    fake.emit('close');
    fake.emit('close'); // 두 번째는 scheduleReconnect에서 early-return

    vi.advanceTimersByTime(2000);
    // 타이머 한 번만 예약 → reconnect 1회만 호출
    expect(fake.reconnect).toHaveBeenCalledTimes(1);
  });
});

describe('HistorianMqttClient — 메시지 라우팅', () => {
  it("'message' 이벤트 → onMessage(topic, payload) 호출", async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const onMessage = vi.fn();
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage });
    client.connect();

    const payload = Buffer.from('{"x":1}');
    fake.emit('message', 'ds/EQ/status', payload);

    expect(onMessage).toHaveBeenCalledWith('ds/EQ/status', payload);
  });

  it('onMessage 핸들러가 throw해도 client는 크래시하지 않음', async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const onMessage = vi.fn(() => {
      throw new Error('boom');
    });
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage });
    client.connect();

    expect(() => fake.emit('message', 'ds/EQ/status', Buffer.from(''))).not.toThrow();
    expect(onMessage).toHaveBeenCalled();
  });
});

describe('HistorianMqttClient.end — 종료 동작', () => {
  it('end() → client.end(force, {}, cb) 호출 + 예약된 재연결 타이머 취소', async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();

    // 재연결 타이머 예약
    fake.emit('close');
    expect(fake.reconnect).not.toHaveBeenCalled();

    // end 호출 → 타이머 취소되어 reconnect 발화 안 함
    await client.end(true);
    expect(fake.end).toHaveBeenCalledTimes(1);
    expect(fake.end.mock.calls[0]![0]).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(fake.reconnect).not.toHaveBeenCalled();
  });

  it('종료 중에는 이후의 close 이벤트가 재연결을 유발하지 않음', async () => {
    const fake = makeFakeClient();
    connectMock.mockReturnValue(fake);
    const { HistorianMqttClient } = await loadClient();

    const client = new HistorianMqttClient({ env: makeEnv(), onMessage: vi.fn() });
    client.connect();

    await client.end(true);
    fake.emit('close');

    vi.advanceTimersByTime(5000);
    expect(fake.reconnect).not.toHaveBeenCalled();
  });
});
