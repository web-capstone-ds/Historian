import { describe, it, expect, vi } from 'vitest';
import {
  parseTopic,
  routeMessage,
  type HandlerMap,
} from '../../src/mqtt/router.js';

describe('parseTopic', () => {
  it('정상 토픽 → equipment_id / segment 분리', () => {
    expect(parseTopic('ds/DS-VIS-001/heartbeat')).toEqual({
      equipmentId: 'DS-VIS-001',
      segment: 'heartbeat',
    });
    expect(parseTopic('ds/DS-VIS-042/inspection_result_fail_et52')).toEqual({
      equipmentId: 'DS-VIS-042',
      segment: 'inspection_result_fail_et52',
    });
  });

  it('8종 segment 전부 인식 가능', () => {
    const segments = [
      'heartbeat', 'status', 'result', 'lot',
      'alarm', 'recipe', 'control', 'oracle',
    ];
    for (const seg of segments) {
      expect(parseTopic(`ds/EQ-1/${seg}`)).toEqual({
        equipmentId: 'EQ-1',
        segment: seg,
      });
    }
  });

  it('ds 접두어 없음 / 세그먼트 개수 불일치 → null', () => {
    expect(parseTopic('foo/bar/baz')).toBeNull();
    expect(parseTopic('ds/DS-VIS-001')).toBeNull();
    expect(parseTopic('ds/DS-VIS-001/heartbeat/extra')).toBeNull();
    expect(parseTopic('')).toBeNull();
    expect(parseTopic('ds//heartbeat')).toBeNull();
  });
});

function makeSpyMap(): HandlerMap & {
  _calls: Record<string, Array<{ eq: string; payload: Buffer }>>;
} {
  const calls: Record<string, Array<{ eq: string; payload: Buffer }>> = {};
  const keys = [
    'heartbeat', 'status', 'result', 'lot',
    'alarm', 'recipe', 'control', 'oracle',
  ];
  const map = {} as HandlerMap;
  for (const k of keys) {
    calls[k] = [];
    map[k] = async (eq: string, payload: Buffer): Promise<void> => {
      calls[k]!.push({ eq, payload });
    };
  }
  return Object.assign(map, { _calls: calls });
}

describe('routeMessage', () => {
  it('8종 토픽 모두 올바른 핸들러로 라우팅', async () => {
    const spy = makeSpyMap();
    const cases = [
      ['ds/DS-VIS-001/heartbeat', 'heartbeat'],
      ['ds/DS-VIS-001/status', 'status'],
      ['ds/DS-VIS-001/result', 'result'],
      ['ds/DS-VIS-001/lot', 'lot'],
      ['ds/DS-VIS-001/alarm', 'alarm'],
      ['ds/DS-VIS-001/recipe', 'recipe'],
      ['ds/DS-VIS-001/control', 'control'],
      ['ds/DS-VIS-001/oracle', 'oracle'],
    ];
    for (const [topic] of cases) {
      await routeMessage(topic!, Buffer.from('{}'), spy);
    }
    for (const [, seg] of cases) {
      expect(spy._calls[seg!]!.length).toBe(1);
      expect(spy._calls[seg!]![0]!.eq).toBe('DS-VIS-001');
    }
  });

  it('빈 페이로드 → 어떤 핸들러도 호출되지 않음', async () => {
    const spy = makeSpyMap();
    await routeMessage('ds/DS-VIS-001/alarm', Buffer.alloc(0), spy);
    for (const k of Object.keys(spy._calls)) {
      expect(spy._calls[k]!.length).toBe(0);
    }
  });

  it('미인식 토픽 → 크래시 없음, 핸들러 호출 없음', async () => {
    const spy = makeSpyMap();
    await expect(
      routeMessage('foo/bar/baz', Buffer.from('{}'), spy),
    ).resolves.toBeUndefined();
    await expect(
      routeMessage('ds/EQ-1/unknown_segment', Buffer.from('{}'), spy),
    ).resolves.toBeUndefined();
    await expect(
      routeMessage('ds/EQ-1/heartbeat/extra', Buffer.from('{}'), spy),
    ).resolves.toBeUndefined();
    for (const k of Object.keys(spy._calls)) {
      expect(spy._calls[k]!.length).toBe(0);
    }
  });

  it('핸들러가 throw해도 상위는 크래시 없음', async () => {
    const badMap: HandlerMap = {
      heartbeat: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      routeMessage('ds/EQ-1/heartbeat', Buffer.from('{}'), badMap),
    ).resolves.toBeUndefined();
  });

  it('토픽에서 equipment_id 정확 추출', async () => {
    const spy = makeSpyMap();
    await routeMessage('ds/DS-VIS-042/heartbeat', Buffer.from('{}'), spy);
    expect(spy._calls['heartbeat']![0]!.eq).toBe('DS-VIS-042');
  });

  it('payload를 핸들러에 그대로 전달 (바이트 보존)', async () => {
    const spy = makeSpyMap();
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    await routeMessage('ds/EQ/status', buf, spy);
    expect(spy._calls['status']![0]!.payload).toEqual(buf);
  });
});

// DEFAULT_HANDLER_MAP import-time side effect 검증
describe('DEFAULT_HANDLER_MAP', () => {
  it('실제 import 가능 + 8개 segment 등록 확인', async () => {
    const { DEFAULT_HANDLER_MAP } = await import('../../src/mqtt/router.js');
    const keys = Object.keys(DEFAULT_HANDLER_MAP).sort();
    expect(keys).toEqual([
      'alarm', 'control', 'heartbeat', 'lot',
      'oracle', 'recipe', 'result', 'status',
    ]);
    for (const k of keys) {
      expect(typeof DEFAULT_HANDLER_MAP[k]).toBe('function');
    }
    // 로거 호출 방지
    vi.doMock('../../src/utils/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
  });
});
