import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Test-only transport; does not load dotenv, the app entrypoint, routers or DB. */
export const commands = [
  "snapshot", "release_http", "release_job", "enqueue_active", "enqueue_waiting",
  "enqueue_retry", "enqueue_peer", "enqueue_refused",
] as const;
export type Command = typeof commands[number];
const eventPhases = ["ready", "http_started", "http_settled", "job_started", "job_settled",
  "fenced", "shutdown_result", "resources_closed", "command_result", "fixture_failed"] as const;
type EventPhase = typeof eventPhases[number];
type WaitPhase = EventPhase | Command | "operation" | "child_exit" | "cleanup_child_exit" |
  "cleanup_queue_delete" | "cleanup_inspector_close";
export type FixtureEvent = {
  event: string;
  id?: number;
  port?: number;
  backend?: string;
  job?: string;
  attempt?: number;
  status?: string;
  scope?: string;
  state?: string;
  active?: number;
  stopFailures?: number;
  resourcesClosed?: boolean;
  listening?: boolean;
  effects?: number;
};
export const WAIT_MS = 8_000;

export function loopbackRedisUrl(value: string | undefined): string {
  const match = /^redis:\/\/127\.0\.0\.1:([1-9]\d*)$/.exec(value ?? "");
  if (!match || Number(match[1]) > 65_535) throw new Error("rehearsal_requires_exact_loopback_redis");
  return value!;
}

export function fixtureConfig(env: NodeJS.ProcessEnv) {
  const redisUrl = loopbackRedisUrl(env.RECONCILEAI_TEST_REDIS_URL);
  if (env.REDIS_URL !== redisUrl || env.NODE_ENV !== "test") {
    throw new Error("rehearsal_fixture_environment_mismatch");
  }
  const queueName = env.RECONCILEAI_TEST_QUEUE_NAME ?? "";
  if (!/^test-recovery-rehearsal-[a-f0-9]{32}$/.test(queueName)) {
    throw new Error("rehearsal_requires_unique_synthetic_queue");
  }
  const timeout = env.RECONCILEAI_TEST_SHUTDOWN_MS;
  if (timeout !== "10000" && timeout !== "200") throw new Error("rehearsal_invalid_deadline");
  const allowed = new Set([
    "NODE_ENV", "REDIS_URL", "RECONCILEAI_TEST_REDIS_URL",
    "RECONCILEAI_TEST_QUEUE_NAME", "RECONCILEAI_TEST_SHUTDOWN_MS",
  ]);
  if (Object.keys(env).some(key => !allowed.has(key))) throw new Error("rehearsal_unexpected_environment");
  return { redisUrl, queueName, timeoutMs: Number(timeout) };
}

export function childEnvironment(redisUrl: string, queueName: string, shortDeadline = false): NodeJS.ProcessEnv {
  const env = {
    NODE_ENV: "test", REDIS_URL: redisUrl, RECONCILEAI_TEST_REDIS_URL: redisUrl,
    RECONCILEAI_TEST_QUEUE_NAME: queueName,
    RECONCILEAI_TEST_SHUTDOWN_MS: shortDeadline ? "200" : "10000",
  };
  fixtureConfig(env); // Fail before fork, not merely after connecting.
  return env;
}

export function parseCommand(value: unknown): { id: number; command: Command } {
  if (!value || typeof value !== "object") throw new Error("rehearsal_invalid_command");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "command,id" ||
      !Number.isSafeInteger(object.id) || Number(object.id) < 1 ||
      !commands.includes(object.command as Command)) throw new Error("rehearsal_invalid_command");
  return { id: Number(object.id), command: object.command as Command };
}

export async function bounded<T>(work: Promise<T>, timeoutMs = WAIT_MS, phase: WaitPhase = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`rehearsal_wait_timeout_${phase}`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Buffers handshakes so a fast worker cannot outrun its observer. Never echoes IPC/logs. */
export class FixtureProcess {
  readonly child: ChildProcess;
  private readonly events: FixtureEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private sequence = 0;
  private failed = false;
  private exited = false;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(redisUrl: string, queueName: string, shortDeadline = false) {
    this.child = fork(fileURLToPath(new URL("./subprocessRehearsal.fixture.testkit.ts", import.meta.url)), [], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
      env: childEnvironment(redisUrl, queueName, shortDeadline),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.exit = new Promise(resolve => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
        this.notify();
      });
    });
    this.child.on("error", () => { this.failed = true; this.notify(); });
    this.child.on("message", value => {
      if (!value || typeof value !== "object") { this.failed = true; this.notify(); return; }
      const event = value as FixtureEvent;
      if (event.event === "fixture_failed" || this.events.length >= 128) this.failed = true;
      this.events.push(event);
      this.notify();
    });
  }

  private notify() { for (const waiter of this.waiters) waiter(); }

  async take(event: EventPhase, match: (value: FixtureEvent) => boolean = () => true,
    phase: WaitPhase = event): Promise<FixtureEvent> {
    let check!: () => void;
    const work = new Promise<FixtureEvent>((resolve, reject) => {
      check = () => {
        const index = this.events.findIndex(value => value.event === event && match(value));
        if (index >= 0) { resolve(this.events.splice(index, 1)[0]); return; }
        if (this.failed || this.exited) reject(new Error("rehearsal_child_failed_or_exited"));
      };
      this.waiters.add(check);
      check();
    });
    try { return await bounded(work, WAIT_MS, phase); } finally { this.waiters.delete(check); }
  }

  async command(command: Command): Promise<FixtureEvent> {
    const id = ++this.sequence;
    // Register first. Callback errors are fixed-code failures, never echoed.
    const response = this.take("command_result", value => value.id === id, command);
    this.child.send({ id, command }, error => {
      if (error) { this.failed = true; this.notify(); }
    });
    return response;
  }

  signal(signal: "SIGTERM" | "SIGINT" = "SIGTERM") {
    if (!this.child.kill(signal)) throw new Error("rehearsal_signal_failed");
  }

  async killAndWait(): Promise<void> {
    if (!this.exited) this.child.kill("SIGKILL");
    await bounded(this.exit, WAIT_MS, "cleanup_child_exit");
  }
}
