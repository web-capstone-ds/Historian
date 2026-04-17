import { loadEnv } from './config/env.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info(
    {
      mqttBroker: env.mqtt.brokerUrl,
      mqttClientId: env.mqtt.clientId,
      tsdbHost: env.tsdb.host,
      tsdbDatabase: env.tsdb.database,
    },
    'Historian bootstrapping (H1 — env loaded)',
  );

  logger.info('H1 scaffold ready. H2(schema) / H3(MQTT client) 구현 대기 중.');
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during bootstrap');
  process.exit(1);
});
