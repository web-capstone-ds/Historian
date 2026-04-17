import { loadEnv } from './config/env.js';
import { logger } from './utils/logger.js';
import { HistorianMqttClient } from './mqtt/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info(
    {
      mqttBroker: env.mqtt.brokerUrl,
      mqttClientId: env.mqtt.clientId,
      tsdbHost: env.tsdb.host,
      tsdbDatabase: env.tsdb.database,
    },
    'Historian bootstrapping',
  );

  // H4(라우터) 적용 전 임시 핸들러: 수신 토픽과 페이로드 길이만 로깅
  const mqttClient = new HistorianMqttClient({
    env,
    onMessage: (topic, payload) => {
      if (payload.length === 0) {
        logger.debug({ topic }, 'Empty payload (retained clear), ignoring');
        return;
      }
      logger.debug({ topic, bytes: payload.length }, 'Message received');
    },
  });

  mqttClient.connect();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await mqttClient.end(true);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Error during MQTT shutdown',
      );
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during bootstrap');
  process.exit(1);
});
