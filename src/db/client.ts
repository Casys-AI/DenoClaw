import { ConfigError } from "../shared/errors.ts";

export interface RawDbClient {
  llmCall: {
    create(args: Record<string, unknown>): Promise<unknown>;
    findMany(args: Record<string, unknown>): Promise<unknown[]>;
    aggregate(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    count(args: Record<string, unknown>): Promise<number>;
  };
  toolExecution: {
    create(args: Record<string, unknown>): Promise<unknown>;
    findMany(args: Record<string, unknown>): Promise<unknown[]>;
    groupBy(args: Record<string, unknown>): Promise<unknown[]>;
    count(args: Record<string, unknown>): Promise<number>;
  };
  conversation: {
    create(args: Record<string, unknown>): Promise<unknown>;
  };
  agentTask: {
    create(args: Record<string, unknown>): Promise<unknown>;
    update(args: Record<string, unknown>): Promise<unknown>;
    upsert(args: Record<string, unknown>): Promise<unknown>;
    count(args: Record<string, unknown>): Promise<number>;
    findMany(args: Record<string, unknown>): Promise<unknown[]>;
  };
  dailyMetrics: {
    findMany(args: Record<string, unknown>): Promise<unknown[]>;
    upsert(args: Record<string, unknown>): Promise<unknown>;
  };
  $disconnect(): Promise<void>;
}

interface PrismaClientModule {
  PrismaClient: new (args: { adapter: unknown }) => RawDbClient;
}

interface PrismaAdapterModule {
  PrismaPg: new (args: { connectionString: string }) => unknown;
}

let dbPromise: Promise<RawDbClient> | null = null;

export function isAnalyticsConfigured(): boolean {
  return Boolean(Deno.env.get("DATABASE_URL"));
}

export async function getDb(): Promise<RawDbClient> {
  if (!dbPromise) {
    dbPromise = createDbClient().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return await dbPromise;
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  dbPromise = null;
  if (db) {
    await db.$disconnect();
  }
}

async function createDbClient(): Promise<RawDbClient> {
  const connectionString = Deno.env.get("DATABASE_URL");
  if (!connectionString) {
    throw new ConfigError(
      "ANALYTICS_DATABASE_URL_MISSING",
      {},
      "Set DATABASE_URL to enable persistent analytics",
    );
  }

  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
    loadGeneratedClientModule(),
    loadAdapterModule(),
  ]);

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

async function loadGeneratedClientModule(): Promise<PrismaClientModule> {
  try {
    const generatedClientPath = "./generated/" + "client.ts";
    return await import(generatedClientPath) as PrismaClientModule;
  } catch (error) {
    if (!isModuleResolutionError(error)) throw error;
    throw new ConfigError(
      "ANALYTICS_CLIENT_UNAVAILABLE",
      { cause: toErrorMessage(error) },
      "Run `deno task db:generate` to generate the Prisma client",
    );
  }
}

async function loadAdapterModule(): Promise<PrismaAdapterModule> {
  try {
    const adapterSpecifier = "@prisma/" + "adapter-pg";
    return await import(adapterSpecifier) as PrismaAdapterModule;
  } catch (error) {
    if (!isModuleResolutionError(error)) throw error;
    throw new ConfigError(
      "ANALYTICS_ADAPTER_UNAVAILABLE",
      { cause: toErrorMessage(error) },
      "Install Prisma dependencies before enabling persistent analytics",
    );
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isModuleResolutionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return error.name === "NotFound" ||
    error.name === "TypeError" ||
    /cannot find module/i.test(error.message) ||
    /module not found/i.test(error.message) ||
    /failed to resolve module/i.test(error.message) ||
    /could not resolve/i.test(error.message);
}
