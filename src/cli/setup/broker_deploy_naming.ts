import {
  deriveBrokerAppName,
  deriveBrokerKvName,
} from "../../shared/naming.ts";

export interface BrokerDeployNamingInput {
  requestedApp?: string;
  storedApp?: string;
  storedKvDatabase?: string;
  canonicalBrokerApp?: string;
}

export interface BrokerDeployNamingResolution {
  app: string;
  kvDatabase: string;
  migrationNotices: string[];
}

export function resolveBrokerDeployNaming(
  input: BrokerDeployNamingInput,
): BrokerDeployNamingResolution {
  const canonicalBrokerApp = input.canonicalBrokerApp ?? deriveBrokerAppName();
  const app = input.requestedApp ??
    (input.storedApp === "denoclaw" ? canonicalBrokerApp : input.storedApp) ??
    canonicalBrokerApp;
  const kvDatabase =
    (input.storedKvDatabase === "denoclaw-kv" && app === canonicalBrokerApp)
      ? deriveBrokerKvName(app)
      : input.storedKvDatabase ?? deriveBrokerKvName(app);

  const migrationNotices: string[] = [];
  if (
    input.requestedApp === undefined &&
    input.storedApp === "denoclaw" &&
    app === canonicalBrokerApp
  ) {
    migrationNotices.push(
      `Migrating legacy broker app naming from "denoclaw" to "${canonicalBrokerApp}".`,
    );
  }
  if (
    input.requestedApp === undefined &&
    input.storedKvDatabase === "denoclaw-kv" &&
    kvDatabase === deriveBrokerKvName(app)
  ) {
    migrationNotices.push(
      `Migrating legacy broker KV naming from "denoclaw-kv" to "${kvDatabase}".`,
    );
  }

  return { app, kvDatabase, migrationNotices };
}
