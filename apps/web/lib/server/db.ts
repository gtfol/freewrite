import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function databasePoolConfig(
  connectionString: string,
  ca?: string,
  poolMax?: string
): PoolConfig {
  let url: URL;
  let user: string;
  let password: string;
  let database: string;
  try {
    url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
      throw new Error();
    }
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    // URL parsing errors can include the database password.
    throw new Error("DATABASE_URL must be a valid Postgres connection URL.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const certificate = ca?.replace(/\\n/g, "\n").trim();

  return {
    // pg reparses connectionString after ssl and can replace its verification
    // settings. Pass explicit fields so URL options cannot weaken TLS or change
    // the host after the loopback check.
    host,
    port: url.port ? Number(url.port) : 5432,
    user,
    password,
    database,
    max: Number(poolMax) || 5,
    ssl: local ? false : { rejectUnauthorized: true, ...(certificate ? { ca: certificate } : {}) },
  };
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool(databasePoolConfig(
      connectionString,
      process.env.DATABASE_SSL_CA,
      process.env.DATABASE_POOL_MAX
    ));
  }
  return pool;
}
