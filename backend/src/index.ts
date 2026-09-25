import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import mqtt from 'mqtt';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface MeterFirmware {
  meterId: string;
  firmwareVersion: string;
  reportedAt: string;
}

const firmwareByMeter = new Map<string, MeterFirmware>();

const LATEST_FIRMWARE_VERSION = process.env.LATEST_FIRMWARE_VERSION || '1.0.0';

function isOutdated(version: string): boolean {
  return version !== LATEST_FIRMWARE_VERSION;
}

function recordFirmware(meterId: string, firmwareVersion: string): MeterFirmware {
  const record: MeterFirmware = {
    meterId,
    firmwareVersion,
    reportedAt: new Date().toISOString(),
  };
  firmwareByMeter.set(meterId, record);
  return record;
}

const mqttUrl = process.env.MQTT_URL || 'mqtt://localhost:1883';
const mqttClient = mqtt.connect(mqttUrl);

mqttClient.on('connect', () => {
  mqttClient.subscribe('meters/+/telemetry');
});

mqttClient.on('message', (topic: string, payload: Buffer) => {
  try {
    const data = JSON.parse(payload.toString());
    const parts = topic.split('/');
    const meterId = data.meterId || parts[1];
    if (!meterId) {
      return;
    }
    if (typeof data.firmware_version === 'string' && data.firmware_version.length > 0) {
      const record = recordFirmware(meterId, data.firmware_version);
      if (isOutdated(record.firmwareVersion)) {
        console.warn(
          `Meter ${meterId} is running outdated firmware ${record.firmwareVersion} (latest ${LATEST_FIRMWARE_VERSION})`
        );
      }
    }
  } catch (err) {
    console.error('Failed to parse MQTT payload', err);
  }
});

app.get('/api/meters/firmware-report', (_req: Request, res: Response) => {
  const report = Array.from(firmwareByMeter.values()).map((record) => ({
    ...record,
    outdated: isOutdated(record.firmwareVersion),
  }));
  res.json({
    latestFirmwareVersion: LATEST_FIRMWARE_VERSION,
    meters: report,
  });
});

app.get('/api/meters/:meterId/firmware', (req: Request, res: Response) => {
  const record = firmwareByMeter.get(req.params.meterId);
  if (!record) {
    return res.status(404).json({ error: 'No firmware version recorded for meter' });
  }
  res.json({
    ...record,
    outdated: isOutdated(record.firmwareVersion),
    latestFirmwareVersion: LATEST_FIRMWARE_VERSION,
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});

export { app, pool, recordFirmware, isOutdated, firmwareByMeter };
