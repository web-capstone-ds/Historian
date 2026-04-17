import mqtt, { type MqttClient } from 'mqtt';
import type { HistorianEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getBackoffDelayMs } from '../utils/backoff.js';
import { SUBSCRIPTIONS } from './subscriptions.js';

export type MessageHandler = (topic: string, payload: Buffer) => void;

export interface HistorianMqttClientOptions {
  env: HistorianEnv;
  onMessage: MessageHandler;
}

export class HistorianMqttClient {
  private readonly env: HistorianEnv;
  private readonly onMessage: MessageHandler;
  private client: MqttClient | null = null;
  private attempt = 0;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: HistorianMqttClientOptions) {
    this.env = opts.env;
    this.onMessage = opts.onMessage;
  }

  connect(): void {
    if (this.client) {
      logger.warn('MQTT client already initialized, ignoring connect()');
      return;
    }
    this.client = this.buildClient();
    this.attachHandlers(this.client);
  }

  private buildClient(): MqttClient {
    logger.info(
      { brokerUrl: this.env.mqtt.brokerUrl, clientId: this.env.mqtt.clientId },
      'Connecting to MQTT broker',
    );
    return mqtt.connect(this.env.mqtt.brokerUrl, {
      clientId: this.env.mqtt.clientId,
      username: this.env.mqtt.username,
      password: this.env.mqtt.password || undefined,
      clean: false, // 세션 유지 (명세서 §5.1)
      keepalive: 60,
      protocolVersion: 5,
      properties: {
        sessionExpiryInterval: 3600, // 1시간
      },
      reconnectPeriod: 0, // 내장 재연결 비활성화 (커스텀 백오프 사용)
      connectTimeout: 10_000,
      resubscribe: false, // 수동 재구독
    });
  }

  private attachHandlers(client: MqttClient): void {
    client.on('connect', () => {
      this.attempt = 0;
      logger.info('MQTT connected');
      this.subscribeAll();
    });

    client.on('reconnect', () => {
      logger.info({ attempt: this.attempt }, 'MQTT reconnect event');
    });

    client.on('close', () => {
      logger.warn('MQTT connection closed');
      if (this.shuttingDown) return;
      this.scheduleReconnect();
    });

    client.on('offline', () => {
      logger.warn('MQTT client offline');
    });

    client.on('error', (err) => {
      logger.error({ err: err.message }, 'MQTT error');
    });

    client.on('message', (topic, payload) => {
      try {
        this.onMessage(topic, payload);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), topic },
          'Message handler threw',
        );
      }
    });
  }

  private subscribeAll(): void {
    if (!this.client) return;
    for (const { topic, qos } of SUBSCRIPTIONS) {
      this.client.subscribe(topic, { qos }, (err, granted) => {
        if (err) {
          logger.error({ err: err.message, topic, qos }, 'Subscribe failed');
          return;
        }
        logger.info({ topic, qos, granted }, 'Subscribed');
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // 이미 예약됨
    const delay = getBackoffDelayMs(this.attempt);
    logger.warn(
      { attempt: this.attempt + 1, delayMs: Math.round(delay) },
      'Scheduling MQTT reconnect',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attempt += 1;
      if (!this.client) return;
      try {
        this.client.reconnect();
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Reconnect attempt threw',
        );
        this.scheduleReconnect();
      }
    }, delay);
  }

  async end(force = false): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.client) return;
    await new Promise<void>((resolve) => {
      this.client!.end(force, {}, () => resolve());
    });
    this.client = null;
  }
}
