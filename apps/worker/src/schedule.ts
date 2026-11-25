import { outlets } from "@sisaku/db";
import { DelayedError, Queue, type Job, type JobSchedulerJson } from "bullmq";
import * as z from "zod";
import { finishedJobOptions, PIPELINE_QUEUE, queueOptions, type PipelineRedis } from "./queue";
import type { createPipelineRuns, Db } from "./runs";
import { PermanentError } from "./steps";

/** The BullMQ job that starts a scheduled run. The steps' jobs are named after the steps. */
export const START_JOB = "start";

const START_HOUR = 22;
/** From this hour a missed night is too late to be useful. */
const TOO_LATE_HOUR = 6;
const PATTERN = `0 ${START_HOUR} * * *`;
const ID_PREFIX = "night-";
/** How much earlier than its time a start is still taken for clocks that differ. */
const EARLY_MS = 60_000;

/**
 * A start that fails, as when Postgres is down, is tried every minute from 22:00 to 06:00.
 *
 * BullMQ keeps these options with each scheduler, and `sync` does not compare them. After changing
 * them, remove the `night-*` schedulers from Redis: the next worker start adds them again, and
 * catches up a start that was pending.
 */
const START_OPTIONS = {
  attempts: (24 - START_HOUR + TOO_LATE_HOUR) * 60,
  backoff: { type: "fixed", delay: 60_000 },
  ...finishedJobOptions,
};

/** The timezone is the one the start was scheduled in: the outlet's may have changed since. */
const startJobData = z.object({ outletId: z.uuid(), timezone: z.string() });
export type ScheduledStart = z.infer<typeof startJobData>;

export type PipelineScheduleDeps = {
  db: Db;
  redis: PipelineRedis;
  runs: ReturnType<typeof createPipelineRuns>;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
};

/** The outlet-local day and hour of a moment. */
function localTime(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

function dayBefore(date: string) {
  return new Date(Date.parse(date) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The business date of the latest 22:00, and whether its run would still be useful. */
function latestNight(now: Date, timezone: string) {
  const { date, hour } = localTime(now, timezone);
  if (hour >= START_HOUR) return { date, useful: true };
  return { date: dayBefore(date), useful: hour < TOO_LATE_HOUR };
}

function isTimezone(timezone: string) {
  try {
    localTime(new Date(), timezone);
    return true;
  } catch {
    return false;
  }
}

/** Whether a scheduler starts the outlet's runs, forever. Bull Board can change all of this. */
function isFor(scheduler: JobSchedulerJson, { outletId, timezone }: ScheduledStart) {
  const data = startJobData.safeParse(scheduler.template?.data).data;
  return (
    scheduler.name === START_JOB &&
    scheduler.pattern === PATTERN &&
    scheduler.tz === timezone &&
    data?.outletId === outletId &&
    data.timezone === timezone &&
    scheduler.endDate === undefined &&
    scheduler.limit === undefined
  );
}

/** Starts every outlet's nightly pipeline at 22:00 its time, and catches up a missed night. */
export function createPipelineSchedule(deps: PipelineScheduleDeps) {
  const { db, runs } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => console.error(message, error ?? ""));
  const queue = new Queue<ScheduledStart>(PIPELINE_QUEUE, queueOptions(deps.redis));

  async function startRun(outletId: string, date: string) {
    const found = await runs.startScheduled({ outletId, date });
    if (!found) log(`No run for outlet ${outletId}: it no longer exists`);
  }

  async function skip(outletId: string, date: string) {
    if (await runs.findScheduled(outletId, date)) return;
    log(`The night of ${date} for outlet ${outletId} was missed, and is skipped: it is too late`);
  }

  /** Starts the latest night's run, if it has none and it is still useful. */
  async function catchUp({ outletId, timezone }: ScheduledStart, at = now()) {
    const night = latestNight(at, timezone);
    if (night.useful) await startRun(outletId, night.date);
    else await skip(outletId, night.date);
  }

  /**
   * Starts the run that was scheduled for `scheduledAt`. After an outage BullMQ starts the oldest
   * night that was missed: that one is skipped, and the latest is caught up instead.
   */
  async function start(scheduled: ScheduledStart, scheduledAt: Date): Promise<void> {
    const { date } = localTime(scheduledAt, scheduled.timezone);
    // Redis's clock may be a little ahead of this one.
    const at = new Date(Math.max(now().getTime(), scheduledAt.getTime()));
    if (date !== latestNight(at, scheduled.timezone).date) await skip(scheduled.outletId, date);
    await catchUp(scheduled, at);
  }

  return {
    /**
     * Run when the worker starts. Makes the schedules match the outlets, then catches up each
     * outlet's latest 22:00 if it was missed and it is not yet 06:00 there. Fails when it cannot,
     * because a worker that started all the same would lose that night.
     */
    async sync(): Promise<void> {
      // Before the outlets, so that a schedule another worker adds meanwhile is not removed.
      const current = new Map((await queue.getJobSchedulers()).map((s) => [s.key, s]));
      const all = await db
        .select({ outletId: outlets.id, timezone: outlets.timezone })
        .from(outlets);
      const scheduled = all.filter(({ outletId, timezone }) => {
        const valid = isTimezone(timezone);
        if (!valid) log(`Outlet ${outletId} is not scheduled: no timezone "${timezone}"`);
        return valid;
      });

      const wanted = new Set(scheduled.map(({ outletId }) => ID_PREFIX + outletId));
      for (const key of current.keys()) {
        if (key.startsWith(ID_PREFIX) && !wanted.has(key)) await queue.removeJobScheduler(key);
      }
      for (const outlet of scheduled) {
        const key = ID_PREFIX + outlet.outletId;
        const found = current.get(key);
        // Replacing a scheduler drops its start that is due but not yet taken (ADR 0017), so one
        // that is as it should be is left alone.
        if (!found || !isFor(found, outlet)) {
          // An update would keep an end date or a limit set in Bull Board.
          if (found) await queue.removeJobScheduler(key);
          await queue.upsertJobScheduler(
            key,
            { pattern: PATTERN, tz: outlet.timezone },
            { name: START_JOB, data: outlet, opts: START_OPTIONS },
          );
        }
        await catchUp(outlet);
      }
    },

    start,

    /** Executes a start job that a worker took from the queue. */
    async processStart(job: Job, token?: string): Promise<void> {
      const valid = startJobData.safeParse(job.data);
      const scheduledAt = job.opts.prevMillis;
      if (!valid.success || scheduledAt === undefined) {
        throw new PermanentError("Not the start of a scheduled run");
      }
      if (scheduledAt - now().getTime() > EARLY_MS) {
        // Promoted by hand. Run now it would take tonight's place, so it goes back to wait.
        await job.moveToDelayed(scheduledAt, token);
        throw new DelayedError();
      }
      await start(valid.data, new Date(scheduledAt));
    },

    close: () => queue.close(),
  };
}

export type PipelineSchedule = ReturnType<typeof createPipelineSchedule>;
