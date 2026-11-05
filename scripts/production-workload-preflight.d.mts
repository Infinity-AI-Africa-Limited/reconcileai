/** Types for production-workload-preflight.mjs, used by its tests. */

export declare const REPORT_SCHEMA: string;
export declare const EXIT: Readonly<{ report: 0; usage: 2; failed: 3; refused: 4; interrupted: 5 }>;
export declare const QUEUE_NAMES: readonly string[];
export declare const ID_SCAN_LIMIT: number;
export declare const SCAN_COUNT: number;
export declare const SCAN_ROUND_LIMIT: number;
export declare const DEFAULT_BUDGET_SECONDS: number;
export declare const MIN_BUDGET_SECONDS: number;
export declare const MAX_BUDGET_SECONDS: number;
export declare const SAMPLE_ALLOWANCE_SECONDS: number;
export declare const QUERY_TIMEOUT_MS: number;
export declare const CONNECT_TIMEOUT_MS: number;
export declare const REDIS_COMMAND_TIMEOUT_MS: number;

export interface DbSurface {
  id: string;
  group: "reconciliation" | "accepted";
  kind: "work" | "parked" | "subset";
  table: string;
  where: string;
  time: string;
}
export declare const DB_SURFACES: readonly DbSurface[];
export declare const INTAKE_SOURCES: readonly { id: string; table: string; time: string }[];
export declare const INTAKE_CLOCK_MARGIN_SECONDS: number;
export declare const COVERAGE_GAPS: readonly string[];
export declare const ENV_KEYS: readonly string[];
export declare const SESSION_STATEMENTS: readonly string[];

export declare class GuardError extends Error {
  code: string;
  constructor(code: string);
}

export declare function assertReadOnlySql(sql: unknown): string;
export declare function assertReadOnlyRedis(command: string, args: string[]): true;
export declare function assertAggregateOnly(value: unknown): void;
export declare function errorCode(error: unknown): string;
export declare function exitStatusFor(code: string): number;
export declare function allSqlStatements(): string[];
export declare function surfaceSql(surface: DbSurface): string;
export declare function intakeSql(source: { table: string; time: string }): string;

export interface Deadline {
  remainingMs(): number;
  expired(): boolean;
  tripped(): boolean;
  trip(): void;
  assert(): void;
}
export declare function createDeadline(ms: number): Deadline;

export interface Options {
  samples: number;
  intervalSeconds: number;
  budgetSeconds: number;
  expectDeployment: string | null;
  expectCommit: string | null;
  envFromApp: boolean;
}
export declare function parseArgs(argv: string[]): Options;
export declare function isPlaceholderIdentifier(value: string): boolean;
export declare function checkExpectations(opts: Options): void;
export declare function selectEnvironment(
  opts: Options,
  ownEnv: Record<string, string | undefined>,
  procRoot?: string,
): { source: "own" | "app_process"; env: Record<string, string | undefined> };
export declare function verifyIdentity(env: Record<string, string | undefined>, opts: Options): void;

export declare function isLoopbackHost(hostname: string): boolean;
export declare function applicationDatabaseTls(
  ssl: unknown,
): "not_requested" | "invalid" | "unverified" | "verified_certificate_and_hostname" | "verified_certificate_only";

export interface DatabasePlan {
  route: "not_configured" | "local_loopback" | "tls_verified_identity";
  application_tls: string;
  connection?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: Record<string, unknown>;
  };
}
export declare function planDatabaseRoute(raw: string | undefined): DatabasePlan;

export interface RedisPlan {
  route: "not_configured" | "local_loopback" | "railway_private_network" | "tls_verified";
  url?: string;
  host?: string;
  tls?: boolean;
}
export declare function planRedisRoute(raw: string | undefined): RedisPlan;

export declare function readWholeNumber(raw: string | undefined): { state: "unset" | "set" | "invalid"; value: number | null };
export declare function readDrainTimeoutSetting(raw: string | undefined): {
  state: "default" | "set" | "invalid_app_refuses_to_start";
  value: number | null;
};
export declare function readStartupModeSetting(raw: string | undefined): "normal" | "maintenance" | "invalid";
export declare function classifyStartCommand(command: unknown): "pnpm_start" | "direct_node_exec" | "other" | "absent";
export declare function inspectRecipe(appDir: string): Record<string, unknown>;
export declare function inspectDeployment(
  env: Record<string, string | undefined>,
  appDir: string,
  databasePlan: DatabasePlan,
): Record<string, unknown>;
export declare function classifyCommand(argv: string[]): string;
export declare function signalMaskHas(statusText: string, field: string, signal?: number): boolean | null;
export declare function launcherChain(procRoot: string, pid: number): string[];
export declare function readAppEnvironment(procRoot?: string): {
  source: "app_process" | "app_process_not_found" | "app_process_ambiguous" | "app_process_unreadable";
  env: Record<string, string>;
};
export declare function inspectProcesses(env: Record<string, string | undefined>, procRoot?: string): Record<string, unknown>;

export interface OpenedDatabase {
  error?: string;
  controls?: {
    engine: "unknown" | "mysql" | "tidb";
    session_time_zone_utc: boolean;
    snapshot: "consistent_snapshot" | "per_statement";
  };
  beginSnapshot(): Promise<void>;
  endSnapshot(): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  abort(): void;
  close(): Promise<void>;
}
export declare function openDatabase(plan: DatabasePlan, appDir: string, deadline?: Deadline): Promise<OpenedDatabase>;

/** The narrow Redis interface the readers use. */
export interface RedisReader {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}
export interface OpenedRedis extends RedisReader {
  error?: string;
  abort(): void;
  close(): Promise<void>;
}
export interface PreparedRedis {
  error?: string;
  tls?: boolean;
  lastError?: () => unknown;
}
export declare function prepareRedis(plan: RedisPlan, appDir: string): PreparedRedis;
export declare function connectRedis(prepared: PreparedRedis, deadline?: Deadline): Promise<OpenedRedis>;
export declare function openRedis(raw: string | undefined, appDir: string, deadline?: Deadline): Promise<OpenedRedis>;

export declare function readQueue(redis: RedisReader, name: string): Promise<Record<string, unknown>>;
export declare function readUnknownQueues(redis: RedisReader): Promise<{
  reading: "ok" | "partial";
  count: number;
  runnable: number;
  scan_rounds: number;
  scan_complete: boolean;
}>;

/** One reading as judge() consumes it; extra fields are ignored. */
export interface Reading {
  reading: string;
  count?: number;
  runnable?: number;
  id_counter?: number | null;
}
export interface Sample {
  database: { surfaces: Record<string, Reading>; intake: Record<string, Reading> };
  redis: { queues: Record<string, Reading>; unknown_queues: Reading };
}
export declare function judge(
  samples: Sample[],
  options?: { incomplete?: boolean },
): {
  reconciliation_unfinished: string;
  queues_runnable: string;
  accepted_unfinished: string;
  producer_activity: string;
  overall: string;
};

/** Stand-ins for the connection openers; tests count their calls. */
export interface Openers {
  database?: (plan: DatabasePlan, appDir: string, deadline: Deadline) => Promise<Partial<OpenedDatabase>>;
  prepareRedis?: (plan: RedisPlan, appDir: string) => PreparedRedis;
  connectRedis?: (prepared: PreparedRedis, deadline: Deadline) => Promise<Partial<OpenedRedis>>;
}

export declare function runPreflight(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  appDir: string;
  procRoot?: string;
  log?: (line: string) => void;
  open?: Openers;
  limits?: { budgetMs?: number };
}): Promise<Record<string, unknown>>;

export declare function main(argv?: string[]): Promise<void>;
