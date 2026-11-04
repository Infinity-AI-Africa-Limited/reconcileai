/** Types for production-workload-preflight.mjs, used by its tests. */

export declare const REPORT_SCHEMA: string;
export declare const QUEUE_NAMES: readonly string[];
export declare const ID_SCAN_LIMIT: number;

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
export declare function allSqlStatements(): string[];
export declare function surfaceSql(surface: DbSurface): string;
export declare function intakeSql(source: { table: string; time: string }): string;

export declare function parseArgs(argv: string[]): {
  samples: number;
  intervalSeconds: number;
  expectDeployment: string | null;
  expectCommit: string | null;
  envFromApp: boolean;
};
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
  opts: { expectDeployment: string | null; expectCommit: string | null },
  appDir: string,
): Record<string, unknown>;
export declare function classifyCommand(argv: string[]): string;
export declare function signalMaskHas(statusText: string, field: string, signal?: number): boolean | null;
export declare function launcherChain(procRoot: string, pid: number): string[];
export declare function readAppEnvironment(procRoot?: string): {
  source: "app_process" | "pid1" | "app_process_unreadable";
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
  close(): Promise<void>;
}
export declare function openDatabase(url: string | undefined, appDir: string): Promise<OpenedDatabase>;

export interface OpenedRedis {
  error?: string;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  close(): Promise<void>;
}
export declare function openRedis(url: string | undefined, appDir: string): Promise<OpenedRedis>;

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
export declare function judge(samples: Sample[]): {
  reconciliation_unfinished: string;
  queues_runnable: string;
  accepted_unfinished: string;
  producer_activity: string;
  overall: string;
};

export declare function runPreflight(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  appDir: string;
  procRoot?: string;
  log?: (line: string) => void;
}): Promise<Record<string, unknown>>;
