import { loadEnv } from './config/env.js';
import { logger } from './utils/logger.js';
import { HistorianMqttClient } from './mqtt/client.js';
import { routeMessage } from './mqtt/router.js';
import { initPool, getPool, closePool } from './db/pool.js';
import {
  initInspectionBatchInserter,
  getInspectionBatchInserter,
} from './handlers/inspection.handler.js';
import { registerShutdownSignals } from './shutdown.js';

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

  initPool(env);
  initInspectionBatchInserter(
    getPool(),
    env.batch.size,
    env.batch.flushIntervalMs,
  );
  logger.info(
    { batchSize: env.batch.size, flushIntervalMs: env.batch.flushIntervalMs },
    'Inspection batch inserter ready',
  );

  const mqttClient = new HistorianMqttClient({
    env,
    onMessage: (topic, payload) => {
      void routeMessage(topic, payload);
    },
  });

  mqttClient.connect();

  registerShutdownSignals({
    stopBatchInserter: async () => {
      const inserter = getInspectionBatchInserter();
      if (inserter) await inserter.stop();
    },
    endMqtt: () => mqttClient.end(true),
    closeDbPool: () => closePool(),
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during bootstrap');
  process.exit(1);
});
