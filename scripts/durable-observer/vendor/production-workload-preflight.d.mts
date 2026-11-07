import type { Socket } from "node:net";

export interface Deadline {
  remainingMs(): number;
  expired(): boolean;
  tripped(): boolean;
  trip(): void;
  assert(): void;
}
export interface DatabasePlan {
  route: "not_configured" | "local_loopback" | "tls_verified_identity";
  application_tls: string;
  connection?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: {
      rejectUnauthorized?: boolean;
      verifyIdentity?: boolean;
      [key: string]: unknown;
    };
    stream?: () => Socket;
  };
}
export interface RedisPlan {
  route:
    | "not_configured"
    | "local_loopback"
    | "railway_private_network"
    | "tls_verified";
  url?: string;
  host?: string;
  tls?: boolean;
}
export interface FailedConnection {
  error: string;
}
export interface DatabaseProbe {
  controls: {
    engine: string;
    session_time_zone_utc: boolean;
    snapshot: string;
  };
  run(sql: string, params?: readonly unknown[]): Promise<unknown>;
  abort(): void;
  close(): Promise<void>;
  beginSnapshot(): Promise<void>;
  endSnapshot(): Promise<void>;
}
export interface RedisClient {
  options: {
    host?: string;
    tls?: unknown;
    path?: unknown;
    connectTimeout: number;
  };
  stream?: { encrypted?: boolean; authorized?: boolean };
  disconnect(): void;
  quit(): Promise<unknown>;
}
export interface PreparedRedis {
  client: RedisClient;
  tls: boolean;
  lastError(): unknown;
}
export interface RedisProbe {
  call(command: string, ...args: string[]): Promise<unknown>;
  abort(): void;
  close(): Promise<void>;
}
export function planDatabaseRoute(raw: string): DatabasePlan;
export function planRedisRoute(raw: string): RedisPlan;
export function createDeadline(ms: number): Deadline;
export function openDatabase(
  plan: DatabasePlan,
  appDir: string,
  deadline?: Deadline
): Promise<DatabaseProbe | FailedConnection>;
export function prepareRedis(
  plan: RedisPlan,
  appDir: string
): PreparedRedis | FailedConnection;
export function connectRedis(
  prepared: PreparedRedis | FailedConnection,
  deadline?: Deadline
): Promise<RedisProbe | FailedConnection>;
