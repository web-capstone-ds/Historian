// 구독 토픽 + QoS (작업명세서 §3.1, §5.2)
// - QoS 1: heartbeat / status / result (주기적 발행, 1회 누락 허용)
// - QoS 2: lot / alarm / recipe / control / oracle (정확히 1회 전달)

export type SubscribeQos = 0 | 1 | 2;

export interface Subscription {
  topic: string;
  qos: SubscribeQos;
}

export const SUBSCRIPTIONS: readonly Subscription[] = [
  { topic: 'ds/+/heartbeat', qos: 1 },
  { topic: 'ds/+/status', qos: 1 },
  { topic: 'ds/+/result', qos: 1 },
  { topic: 'ds/+/lot', qos: 2 },
  { topic: 'ds/+/alarm', qos: 2 },
  { topic: 'ds/+/recipe', qos: 2 },
  { topic: 'ds/+/control', qos: 2 },
  { topic: 'ds/+/oracle', qos: 2 },
] as const;
