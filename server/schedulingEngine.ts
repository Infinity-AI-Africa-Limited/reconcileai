/**
 * Scheduling Engine
 * Manages automated reconciliation task execution with cron-like scheduling.
 * Designed for banking environments requiring reliable, auditable batch processing.
 */
import * as db from "./db";
import { sendReconciliationReport } from "./emailReportService";

// ─── Types ──────────────────────────────────────────────────────────

export interface ScheduleConfig {
  name: string;
  sourceChannelId: number;
  targetChannelId: number;
  frequency: "daily" | "weekly" | "biweekly" | "monthly";
  scheduledTime: string; // HH:mm
  scheduledDayOfWeek?: number; // 0-6 (Sunday=0)
  scheduledDayOfMonth?: number; // 1-31
  timezone?: string;
  amountTolerance?: number;
  dateWindowDays?: number;
  lookbackDays?: number;
  sendEmailReport?: boolean;
  emailRecipients?: string[];
  description?: string;
}

// ─── Next Run Calculation ───────────────────────────────────────────

export function calculateNextRun(
  frequency: string,
  scheduledTime: string,
  options: {
    scheduledDayOfWeek?: number | null;
    scheduledDayOfMonth?: number | null;
    timezone?: string;
    fromDate?: Date;
  } = {}
): Date {
  const { scheduledDayOfWeek, scheduledDayOfMonth, fromDate } = options;
  const now = fromDate || new Date();
  const [hours, minutes] = scheduledTime.split(":").map(Number);

  // Create next run date starting from now
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes);

  switch (frequency) {
    case "daily":
      // If today's time has passed, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      break;

    case "weekly":
      if (scheduledDayOfWeek !== undefined && scheduledDayOfWeek !== null) {
        const currentDay = next.getDay();
        let daysUntil = scheduledDayOfWeek - currentDay;
        if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
          daysUntil += 7;
        }
        next.setDate(next.getDate() + daysUntil);
      } else if (next <= now) {
        next.setDate(next.getDate() + 7);
      }
      break;

    case "biweekly":
      if (scheduledDayOfWeek !== undefined && scheduledDayOfWeek !== null) {
        const currentDay = next.getDay();
        let daysUntil = scheduledDayOfWeek - currentDay;
        if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
          daysUntil += 14;
        }
        next.setDate(next.getDate() + daysUntil);
      } else if (next <= now) {
        next.setDate(next.getDate() + 14);
      }
      break;

    case "monthly":
      if (scheduledDayOfMonth !== undefined && scheduledDayOfMonth !== null) {
        next.setDate(Math.min(scheduledDayOfMonth, daysInMonth(next)));
        if (next <= now) {
          next.setMonth(next.getMonth() + 1);
          next.setDate(Math.min(scheduledDayOfMonth, daysInMonth(next)));
        }
      } else if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      break;
  }

  return next;
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// ─── Schedule Validation ────────────────────────────────────────────

export function validateScheduleConfig(config: ScheduleConfig): string[] {
  const errors: string[] = [];

  if (!config.name || config.name.trim().length === 0) {
    errors.push("Schedule name is required");
  }

  if (!config.scheduledTime || !/^\d{2}:\d{2}$/.test(config.scheduledTime)) {
    errors.push("Scheduled time must be in HH:mm format");
  } else {
    const [h, m] = config.scheduledTime.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      errors.push("Invalid time value");
    }
  }

  if (config.frequency === "weekly" || config.frequency === "biweekly") {
    if (config.scheduledDayOfWeek === undefined || config.scheduledDayOfWeek < 0 || config.scheduledDayOfWeek > 6) {
      errors.push("Day of week (0-6) is required for weekly/biweekly schedules");
    }
  }

  if (config.frequency === "monthly") {
    if (config.scheduledDayOfMonth === undefined || config.scheduledDayOfMonth < 1 || config.scheduledDayOfMonth > 31) {
      errors.push("Day of month (1-31) is required for monthly schedules");
    }
  }

  if (config.sourceChannelId === config.targetChannelId) {
    errors.push("Source and target channels must be different");
  }

  if (config.lookbackDays !== undefined && (config.lookbackDays < 1 || config.lookbackDays > 90)) {
    errors.push("Lookback days must be between 1 and 90");
  }

  if (config.emailRecipients) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of config.emailRecipients) {
      if (!emailRegex.test(email)) {
        errors.push(`Invalid email address: ${email}`);
      }
    }
  }

  return errors;
}

// ─── Schedule Execution ─────────────────────────────────────────────

export async function executeScheduledTask(taskId: number): Promise<{
  success: boolean;
  jobId?: number;
  error?: string;
}> {
  const task = await db.getScheduledTaskById(taskId);
  if (!task) {
    return { success: false, error: "Scheduled task not found" };
  }

  if (!task.isActive) {
    return { success: false, error: "Scheduled task is inactive" };
  }

  // Create run history entry
  const runId = await db.createScheduleRunHistory({
    scheduledTaskId: taskId,
    status: "running",
    startedAt: new Date(),
  });

  try {
    // Calculate date range based on lookback days
    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - task.lookbackDays * 86400000);

    // Create reconciliation job
    const jobId = await db.createReconciliationJob({
      userId: task.userId,
      name: `[Scheduled] ${task.name} — ${new Date().toISOString().split("T")[0]}`,
      sourceChannelId: task.sourceChannelId,
      targetChannelId: task.targetChannelId,
      dateFrom,
      dateTo,
      amountTolerance: String(task.amountTolerance),
      dateWindowDays: task.dateWindowDays,
      engineConfig: JSON.stringify({
        scheduledTaskId: taskId,
        amountTolerance: parseFloat(String(task.amountTolerance)),
        dateWindowDays: task.dateWindowDays,
        lookbackDays: task.lookbackDays,
      }),
      status: "pending",
    });

    if (!jobId) {
      throw new Error("Failed to create reconciliation job");
    }

    // Update run history with job ID
    if (runId) {
      await db.updateScheduleRunHistory(runId, { jobId });
    }

    // Calculate next run
    const nextRun = calculateNextRun(task.frequency, task.scheduledTime, {
      scheduledDayOfWeek: task.scheduledDayOfWeek,
      scheduledDayOfMonth: task.scheduledDayOfMonth,
      timezone: task.timezone,
    });

    // Update task metadata
    await db.updateScheduledTask(taskId, {
      lastRunAt: new Date(),
      lastRunJobId: jobId,
      lastRunStatus: "success",
      nextRunAt: nextRun,
      totalRuns: task.totalRuns + 1,
      successfulRuns: task.successfulRuns + 1,
    });

    return { success: true, jobId };
  } catch (error) {
    console.error(`[Scheduler] Task ${taskId} execution failed:`, error);

    // Calculate next run even on failure
    const nextRun = calculateNextRun(task.frequency, task.scheduledTime, {
      scheduledDayOfWeek: task.scheduledDayOfWeek,
      scheduledDayOfMonth: task.scheduledDayOfMonth,
      timezone: task.timezone,
    });

    // Update task with failure
    await db.updateScheduledTask(taskId, {
      lastRunAt: new Date(),
      lastRunStatus: "failed",
      nextRunAt: nextRun,
      totalRuns: task.totalRuns + 1,
      failedRuns: task.failedRuns + 1,
    });

    // Update run history
    if (runId) {
      await db.updateScheduleRunHistory(runId, {
        status: "failed",
        completedAt: new Date(),
        errorMessage: String(error),
      });
    }

    return { success: false, error: String(error) };
  }
}

// ─── Scheduler Tick (called periodically) ───────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/** Transient DB error codes that warrant a reconnect + retry. */
const DB_TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "PROTOCOL_CONNECTION_LOST"]);

/**
 * Walk the full `cause` chain — Drizzle wraps the mysql2 error, and TiDB's
 * connection drops can arrive nested more than one level deep, so checking
 * only `err.code` and `err.cause.code` would miss them.
 */
function isTransientDbError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as Record<string, unknown>).code;
    if (typeof code === "string" && DB_TRANSIENT_CODES.has(code)) return true;
    current = (current as Record<string, unknown>).cause;
  }
  return false;
}

export async function schedulerTick(): Promise<void> {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 3000;

  /**
   * Tasks already attempted in THIS tick, so a retry never re-runs them.
   *
   * `executeScheduledTask` handles its own failures, but its failure path also
   * writes to the database (to record lastRunStatus/nextRunAt). During the
   * very outage this retry loop exists for, that write throws too and the
   * error escapes. Without this guard the retry would restart the whole tick
   * with the task still marked due — because neither the success nor the
   * failure write landed — and execute it a second time, creating duplicate
   * jobs, reports or emails.
   */
  const attempted = new Set<number>();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const now = new Date();
      const dueTasks = await db.getDueScheduledTasks(now);

      for (const task of dueTasks) {
        if (attempted.has(task.id)) {
          console.warn(`[Scheduler] Task ${task.id} already attempted this tick — skipping to avoid a duplicate run`);
          continue;
        }
        attempted.add(task.id);
        console.log(`[Scheduler] Executing task: ${task.name} (ID: ${task.id})`);
        const result = await executeScheduledTask(task.id);
        if (result.success) {
          console.log(`[Scheduler] Task ${task.id} started job ${result.jobId}`);
        } else {
          console.error(`[Scheduler] Task ${task.id} failed: ${result.error}`);
        }
      }
      return; // success — exit retry loop
    } catch (error) {
      if (isTransientDbError(error) && attempt < MAX_RETRIES) {
        console.warn(`[Scheduler] Transient DB error on attempt ${attempt + 1}/${MAX_RETRIES + 1} — resetting connection and retrying in ${RETRY_DELAY_MS}ms`, (error as Record<string, unknown>).code ?? (error as Record<string, unknown>).message);
        db.resetDb();
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error("[Scheduler] Tick failed:", error);
        return;
      }
    }
  }
}

export function startScheduler(intervalMs: number = 60000): void {
  if (schedulerInterval) {
    console.warn("[Scheduler] Already running");
    return;
  }
  console.log(`[Scheduler] Starting with ${intervalMs}ms interval`);
  schedulerInterval = setInterval(schedulerTick, intervalMs);
  // Run immediately on start
  schedulerTick().catch((err) => console.error("[Scheduler] Initial tick failed:", err));
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Scheduler] Stopped");
  }
}

// ─── Frequency Display Helpers ──────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function getFrequencyDescription(
  frequency: string,
  scheduledTime: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null
): string {
  switch (frequency) {
    case "daily":
      return `Every day at ${scheduledTime}`;
    case "weekly":
      return `Every ${DAY_NAMES[dayOfWeek || 0]} at ${scheduledTime}`;
    case "biweekly":
      return `Every other ${DAY_NAMES[dayOfWeek || 0]} at ${scheduledTime}`;
    case "monthly":
      return `Monthly on day ${dayOfMonth || 1} at ${scheduledTime}`;
    default:
      return `${frequency} at ${scheduledTime}`;
  }
}
