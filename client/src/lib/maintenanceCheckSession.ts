/**
 * The maintenance check page's session: the readings taken on this visit, the
 * attempt in progress, and whether what is on screen is current.
 *
 * Pure: the hook holds the state and the clock, and these functions decide.
 * - One attempt at a time, decided synchronously: a second press while one
 *   runs is refused before anything is sent, whatever the button shows.
 * - An offline press is refused and recorded, never queued to replay later.
 * - An answer belongs to the attempt and the generation that asked for it. A
 *   reset, leaving the page or a change of account starts a new generation, so
 *   a late answer to an older request is dropped, never shown. Leaving does
 *   NOT cancel a request the server has already received.
 * - Evidence is current only while nothing is running, the latest attempt
 *   succeeded and the newest reading is under five minutes old. Anything else
 *   is history, and is labelled so.
 * - A failure becomes a fixed sentence; the server's own text is never shown.
 */
import { assessReadings, describeReadings, type WorkloadVerdict } from "./maintenanceCheck";

/** A reading older than this is history, not the current state. */
export const FRESH_FOR_MS = 5 * 60_000;
export const KEPT_READINGS = 10;

/**
 * The check's mutation runs now or not at all: never paused while offline and
 * replayed on reconnect or focus, never retried, and dropped from the client's
 * cache as soon as nothing observes it.
 */
export const MAINTENANCE_MUTATION_OPTIONS = Object.freeze({
  networkMode: "always",
  retry: false,
  gcTime: 0,
} as const);

export const OFFLINE_MESSAGE = "You are offline, so nothing was sent.";
export const GENERIC_FAILURE = "The check could not be completed. Try again.";
const FAILURES: Record<string, string> = {
  CONFLICT: "A check is already running on the server. Wait for it to finish, then try again.",
  TOO_MANY_REQUESTS: "Checks must be at least ten seconds apart. Try again shortly.",
  FORBIDDEN: "This account cannot run the check.",
  UNAUTHORIZED: "Your session has ended. Sign in again.",
};

/** A fixed sentence for a failure, by its error code only. */
export function failureMessage(code: string | undefined): string {
  return code !== undefined && Object.hasOwn(FAILURES, code) ? FAILURES[code] : GENERIC_FAILURE;
}

export interface ReadingResult {
  checkedAt: string;
  verdict: WorkloadVerdict;
}
export interface SessionReading<R> {
  attemptId: number;
  /** Local admission time: response delivery must never extend freshness. */
  startedAt: number;
  receivedAt: number;
  report: R;
}
export type Attempt =
  | { kind: "none" }
  | { kind: "running"; id: number; startedAt: number }
  | { kind: "failed"; id: number; at: number; message: string }
  | { kind: "succeeded"; id: number; at: number };
export interface CheckSession<R> {
  generation: number;
  nextId: number;
  attempt: Attempt;
  /** When the run of consecutive successful readings was last broken. */
  brokenAt: number;
  readings: SessionReading<R>[];
}

export function newSession<R>(generation = 0): CheckSession<R> {
  return { generation, nextId: 1, attempt: { kind: "none" }, brokenAt: Number.NEGATIVE_INFINITY, readings: [] };
}

/** Start again: no readings, nothing running, and older answers dropped. */
export function resetSession<R>(session: CheckSession<R>): CheckSession<R> {
  return newSession(session.generation + 1);
}

export type Begin<R> =
  | { started: true; session: CheckSession<R>; id: number; generation: number }
  | { started: false; session: CheckSession<R>; reason: "running" | "offline" };

export function beginAttempt<R>(session: CheckSession<R>, now: number, online: boolean): Begin<R> {
  if (session.attempt.kind === "running") return { started: false, session, reason: "running" };
  const id = session.nextId;
  if (!online)
    return {
      started: false,
      reason: "offline",
      session: { ...session, nextId: id + 1, brokenAt: now, attempt: { kind: "failed", id, at: now, message: OFFLINE_MESSAGE } },
    };
  return {
    started: true,
    id,
    generation: session.generation,
    session: { ...session, nextId: id + 1, attempt: { kind: "running", id, startedAt: now } },
  };
}

export type Outcome<R> = { ok: true; report: R } | { ok: false; code: string | undefined };

/** Apply an answer, only if it is for the attempt now running in this generation. */
export function completeAttempt<R extends ReadingResult>(
  session: CheckSession<R>,
  generation: number,
  id: number,
  outcome: Outcome<R>,
  now: number,
): CheckSession<R> {
  if (generation !== session.generation || session.attempt.kind !== "running" || session.attempt.id !== id) return session;
  if (!outcome.ok)
    return { ...session, brokenAt: now, attempt: { kind: "failed", id, at: now, message: failureMessage(outcome.code) } };
  return {
    ...session,
    attempt: { kind: "succeeded", id, at: now },
    readings: [...session.readings, { attemptId: id, startedAt: session.attempt.startedAt, receivedAt: now, report: outcome.report }].slice(-KEPT_READINGS),
  };
}

export type Evidence<R> =
  | { kind: "none" }
  | { kind: "pending"; last: SessionReading<R> | null }
  | { kind: "failed"; message: string; last: SessionReading<R> | null }
  | { kind: "stale"; last: SessionReading<R> }
  | { kind: "current"; last: SessionReading<R> };

/** Whether the newest reading on screen describes now, and if not, why not. */
export function evidenceOf<R extends ReadingResult>(session: CheckSession<R>, now: number): Evidence<R> {
  const last = session.readings.at(-1) ?? null;
  if (session.attempt.kind === "running") return { kind: "pending", last };
  if (session.attempt.kind === "failed") return { kind: "failed", message: session.attempt.message, last };
  if (!last) return { kind: "none" };
  const stamp = last.report.checkedAt;
  const observed = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  // Age runs from the EARLIER of the server's observation and the moment this
  // page sent the request, so neither a late delivery nor a server clock ahead
  // of the browser can stretch the five-minute window. A server stamp later
  // than the browser's clock is skew, not staleness: refusing it would turn
  // every genuine reading into history for a browser whose clock runs a second
  // behind, and buys nothing, since the earlier time already bounds the age.
  // Malformed or noncanonical stamps and a clock that went backwards are
  // history. Conservative freshness, not attestation.
  if (
    !Number.isFinite(now) || !Number.isFinite(last.startedAt) || !Number.isFinite(last.receivedAt) ||
    !Number.isFinite(observed) || new Date(observed).toISOString() !== last.report.checkedAt ||
    last.receivedAt < last.startedAt || now < last.receivedAt ||
    now - Math.min(observed, last.startedAt) >= FRESH_FOR_MS
  ) return { kind: "stale", last };
  return { kind: "current", last };
}

/** One sentence for the session, judging a run of readings only when it is current. */
export function describeSession<R extends ReadingResult>(session: CheckSession<R>, now: number): string {
  const evidence = evidenceOf(session, now);
  switch (evidence.kind) {
    case "none":
      return "No readings yet. Press Run check.";
    case "pending":
      return "Reading… Until it finishes, earlier readings are history, not the current state.";
    case "failed":
      return `The last attempt did not complete: ${evidence.message} Earlier readings are history.`;
    case "stale":
      return "The newest reading is five minutes or more old, or its timing could not be trusted, so it is history. Take a new reading.";
    case "current": {
      const run = session.readings
        .filter(r => r.receivedAt > session.brokenAt)
        .map(r => ({ checkedAt: r.report.checkedAt, verdict: r.report.verdict }));
      return describeReadings(assessReadings(run, now));
    }
  }
}

/** What the controller needs from its surroundings; the hook supplies these. */
export interface CheckControllerPorts<R> {
  /** Send one reading request now. */
  send(): Promise<R>;
  /** Whether the browser says it is online. */
  online(): boolean;
  now(): number;
  /** The error code of a failed request, if it has one. Never its message. */
  codeOf(error: unknown): string | undefined;
  /** Forget the query library's copy of the request. */
  forget(): void;
  /** Told about every new session while attached. */
  changed(session: CheckSession<R>): void;
}

/**
 * The page's lifecycle around the session rules: one request at a time,
 * answers matched to the attempt and generation that asked, and everything
 * dropped on clear, on a change of account and when the page closes.
 */
export class CheckController<R extends ReadingResult> {
  private current: CheckSession<R> = newSession<R>();
  private attached = true;

  constructor(private readonly ports: CheckControllerPorts<R>) {}

  get session(): CheckSession<R> {
    return this.current;
  }

  private commit(next: CheckSession<R>): void {
    if (next === this.current) return;
    this.current = next;
    if (this.attached) this.ports.changed(next);
  }

  run(): void {
    if (!this.attached) return;
    const begun = beginAttempt(this.current, this.ports.now(), this.ports.online());
    this.commit(begun.session);
    if (!begun.started) return;
    const { id, generation } = begun;
    let sent: Promise<R>;
    try {
      sent = this.ports.send();
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(
      report => this.commit(completeAttempt(this.current, generation, id, { ok: true, report }, this.ports.now())),
      (error: unknown) =>
        this.commit(completeAttempt(this.current, generation, id, { ok: false, code: this.ports.codeOf(error) }, this.ports.now())),
    );
  }

  /** Start again: no readings, and any answer still to come is dropped. */
  clear(): void {
    this.commit(resetSession(this.current));
    this.ports.forget();
  }

  /** A different account is signed in: nothing from the old one may show. */
  changeAccount(): void {
    this.clear();
  }

  /**
   * The page closed. Anything in flight is dropped and nothing is reported
   * again until it reopens. This does not cancel a request the server has
   * already received: that reading finishes there, and its answer is ignored.
   */
  detach(): void {
    this.current = resetSession(this.current);
    this.attached = false;
    this.ports.forget();
  }

  attach(): void {
    this.attached = true;
  }
}
