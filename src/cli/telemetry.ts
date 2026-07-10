import os from 'node:os';
import path from 'node:path';

import type { TelemetryOptions } from 'hexbus';

import { APP_NAME, type InrepoPackageInfo } from './app-info.js';

const TELEMETRY_ENDPOINT_ENV = 'INREPO_TELEMETRY_ENDPOINT';
const TELEMETRY_AUTH_TOKEN_ENV = 'INREPO_TELEMETRY_AUTH_TOKEN';

function buildHeaders(): Record<string, string> | undefined {
  const authToken = process.env[TELEMETRY_AUTH_TOKEN_ENV]?.trim();
  if (!authToken) {
    return undefined;
  }

  return {
    authorization: `Bearer ${authToken}`,
  };
}

export function createInrepoTelemetryOptions(
  packageInfo: InrepoPackageInfo,
): TelemetryOptions {
  return {
    appName: APP_NAME,
    defaultProperties: {
      cliVersion: packageInfo.version,
      packageName: packageInfo.name,
    },
    endpoint: process.env[TELEMETRY_ENDPOINT_ENV],
    envVarPrefix: 'INREPO',
    headers: buildHeaders(),
    queueFileName: 'telemetry-queue.json',
    source: 'inrepo-cli',
    stateFileName: 'telemetry.json',
    storageDir: path.join(os.homedir(), '.inrepo'),
  };
}
