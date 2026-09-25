import mqtt, { MqttClient } from 'mqtt';
import { logger } from '../lib/logger.js';

const BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';

let client: MqttClient | null = null;

const BRIDGE_STATUS_TOPIC = 'solargrid/bridge/status';

// Exponential backoff configuration for reconnection
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 32000; // 32 seconds
const BACKOFF_MULTIPLIER = 2;

let reconnectAttempts = 0;

function getReconnectDelay(): number {
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(BACKOFF_MULTIPLIER, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;
  return delay;
}

function resetReconnectAttempts(): void {
  reconnectAttempts = 0;
}

// Issue #846: track the firmware version reported by each meter so the
// backend can store it per meter and surface it via the firmware endpoints.
const meterFirmwareVersions = new Map<string, string>();

/**
 * Extract the firmware version from an incoming MQTT payload. Meters are
 * expected to include `firmware_version` in their telemetry payloads.
 */
export function extractFirmwareVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const version = (payload as Record<string, unknown>).firmware_version;
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/**
 * Record the firmware version reported by a meter. Returns the stored
 * version, or null when the payload did not include one.
 */
export function recordMeterFirmwareVersion(
  meterId: string,
  payload: unknown,
): string | null {
  const version = extractFirmwareVersion(payload);
  if (!version) return null;
  meterFirmwareVersions.set(meterId, version);
  logger.info('Recorded meter firmware version', { meterId, firmwareVersion: version });
  return version;
}

/** Get the stored firmware version for a single meter. */
export function getMeterFirmwareVersion(meterId: string): string | null {
  return meterFirmwareVersions.get(meterId) ?? null;
}

/** List the stored firmware version for every known meter. */
export function getAllMeterFirmwareVersions(): Record<string, string> {
  return Object.fromEntries(meterFirmwareVersions);
}

export function getMqttClient(): MqttClient {
  if (!client) {
    client = mqtt.connect(BROKER, {
      reconnectPeriod: 0, // Disable automatic reconnection to implement custom backoff
      // Issue #600: last-will-and-testament — the broker publishes this on
      // our behalf if we disconnect uncleanly (crash, network loss) without
      // sending an explicit DISCONNECT, so subscribers can detect the
      // bridge went offline instead of just seeing silence.
      will: {
        topic: BRIDGE_STATUS_TOPIC,
        payload: JSON.stringify({ status: 'offline' }),
        qos: 1,
        retain: true,
      },
    });

    client.on('connect', () => {
      resetReconnectAttempts();
      logger.info('MQTT client connected to broker', { broker: BROKER });
      client?.publish(
        BRIDGE_STATUS_TOPIC,
        JSON.stringify({ status: 'online', timestamp: Date.now() }),
        { qos: 1, retain: true },
      );
    });

    client.on('disconnect', () => {
      logger.info('MQTT client disconnected from broker');
      client?.publish(
        BRIDGE_STATUS_TOPIC,
        JSON.stringify({ status: 'offline', timestamp: Date.now() }),
        { qos: 1, retain: true },
        (err) => {
          if (err) logger.error('Failed to publish offline status', { err });
        }
      );
    });

    // Issue #693: Implement exponential backoff reconnection logic
    client.on('error', (err) => {
      logger.error('MQTT client error', { err });
    });

    client.on('close', () => {
      logger.warn('MQTT connection closed, attempting reconnect with exponential backoff');
      const delay = getReconnectDelay();
      logger.info('Scheduling reconnect attempt', {
        attempt: reconnectAttempts,
        delayMs: delay,
      });
      setTimeout(() => {
        logger.info('Attempting to reconnect to MQTT broker', {
          broker: BROKER,
          attempt: reconnectAttempts,
        });
        client?.reconnect();
      }, delay);
    });

    client.on('offline', () => {
      logger.warn('MQTT client went offline');
    });
  }
  return client;
}
