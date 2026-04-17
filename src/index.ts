import { loadEnv } from './config/env.js';
import { logger } from './utils/logger.js';
import { HistorianMqttClient } from './mqtt/client.js';
import { routeMessage } from './mqtt/router.js';

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

  const mqttClient = new HistorianMqttClient({
    env,
    onMessage: (topic, payload) => {
      void routeMessage(topic, payload);
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
