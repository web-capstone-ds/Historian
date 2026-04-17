import 'dotenv/config';

export interface HistorianEnv {
  mqtt: {
    brokerUrl: string;
    username: string;
    password: string;
    clientId: string;
  };
  tsdb: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  batch: {
    size: number;
    flushIntervalMs: number;
  };
  logLevel: string;
}

const REQUIRED_KEYS = [
  'MQTT_BROKER_URL',
  'MQTT_USERNAME',
  'MQTT_CLIENT_ID',
  'TSDB_HOST',
  'TSDB_PORT',
  'TSDB_DATABASE',
  'TSDB_USER',
] as const;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function parseIntEnv(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for env var ${key}: "${raw}"`);
  }
  return n;
}

export function loadEnv(): HistorianEnv {
  const missing = REQUIRED_KEYS.filter(
    (k) => process.env[k] === undefined || process.env[k] === '',
  );
  if (missing.length > 0) {
    console.error(
      `[FATAL] Missing required env vars: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill in values.`,
    );
    process.exit(1);
  }

  return {
    mqtt: {
      brokerUrl: requireEnv('MQTT_BROKER_URL'),
      username: requireEnv('MQTT_USERNAME'),
      password: process.env.MQTT_PASSWORD ?? '',
      clientId: requireEnv('MQTT_CLIENT_ID'),
    },
    tsdb: {
      host: requireEnv('TSDB_HOST'),
      port: parseIntEnv('TSDB_PORT', 5432),
      database: requireEnv('TSDB_DATABASE'),
      user: requireEnv('TSDB_USER'),
      password: process.env.TSDB_PASSWORD ?? '',
    },
    batch: {
      size: parseIntEnv('BATCH_SIZE', 100),
      flushIntervalMs: parseIntEnv('FLUSH_INTERVAL_MS', 1000),
    },
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
