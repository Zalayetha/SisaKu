import { outlets } from "@sisaku/db";
import { Queue, type Job } from "bullmq";
import * as z from "zod";
import {
  finishedJobOptions,
  PIPELINE_QUEUE,
  queueOptions,
  retryOptions,
  type PipelineRedis,
} from "./queue";
import type { createPipelineRuns, Db } from "./runs";
import { PermanentError } from "./steps";

/** The BullMQ job that starts a scheduled run. The steps' jobs are named after the steps. */
export const START_JOB = "start";

const START_HOUR = 22;
/** From this hour a missed night is too late to be useful. */
const TOO_LATE_HOUR = 6;
const PATTERN = `0 ${START_HOUR} * * *`;
const ID_PREFIX = "night-";

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

/** Starts every outlet's nightly pipeline at 22:00 its time, and catches up a missed night. */
export function createPipelineSchedule(deps: PipelineScheduleDeps) {
  const { db, runs } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => console.error(message, error ?? ""));
  const queue = new Queue<ScheduledStart>(PIPELINE_QUEUE, queueOptions(deps.redis));

  const skipped = (outletId: string, date: string) =>
    log(`The night of ${date} for outlet ${outletId} was missed, and is skipped: it is too late`);

  async function startRun(outletId: string, date: string) {
    const run = await runs.startScheduled({ outletId, date });
    if (!run) log(`No run for outlet ${outletId}: it no longer exists`);
  }

  async function catchUp({ outletId, timezone }: ScheduledStart) {
    const night = latestNight(now(), timezone);
    if (night.useful) await startRun(outletId, night.date);
    else if (!(await runs.findScheduled(outletId, night.date))) skipped(outletId, night.date);
  }

  /**
   * Starts the run that was scheduled for `scheduledAt`, unless that night is over: after an
   * outage BullMQ starts the oldest night that was missed.
   */
  async function start({ outletId, timezone }: ScheduledStart, scheduledAt: Date): Promise<void> {
    const { date } = localTime(scheduledAt, timezone);
    // Redis's clock may be a little ahead of this one.
    const moment = new Date(Math.max(now().getTime(), scheduledAt.getTime()));
    const night = latestNight(moment, timezone);
    if (night.useful && night.date === date) await startRun(outletId, date);
    else skipped(outletId, date);
  }

  return {
    /**
     * Run when the worker starts. Makes the schedules match the outlets, then catches up each
     * outlet's latest 22:00 if it was missed and it is not yet 06:00 there.
     */
    async sync(): Promise<void> {
      const all = await db
        .select({ outletId: outlets.id, timezone: outlets.timezone })
        .from(outlets);
      const current = new Map((await queue.getJobSchedulers()).map((s) => [s.key, s]));
      const wanted = new Set(all.map(({ outletId }) => ID_PREFIX + outletId));
      for (const key of current.keys()) {
        if (key.startsWith(ID_PREFIX) && !wanted.has(key)) await queue.removeJobScheduler(key);
      }
      for (const outlet of all) {
        try {
          const key = ID_PREFIX + outlet.outletId;
          const { pattern, tz } = current.get(key) ?? {};
          // Updating a scheduler drops its start that is due but not yet taken (ADR 0017), so one
          // that has not changed is left alone.
          if (pattern !== PATTERN || tz !== outlet.timezone) {
            await queue.upsertJobScheduler(
              key,
              { pattern: PATTERN, tz: outlet.timezone },
              { name: START_JOB, data: outlet, opts: { ...retryOptions(), ...finishedJobOptions } },
            );
          }
          await catchUp(outlet);
        } catch (error) {
          log(`Could not schedule outlet ${outlet.outletId} in ${outlet.timezone}`, error);
        }
      }
    },

    start,

    /** Executes a start taken from the queue. */
    async process(job: Job): Promise<void> {
      const valid = startJobData.safeParse(job.data);
      const scheduledAt = job.opts.prevMillis;
      if (!valid.success || scheduledAt === undefined) {
        throw new PermanentError("Not the start of a scheduled run");
      }
      await start(valid.data, new Date(scheduledAt));
    },

    close: () => queue.close(),
  };
}

export type PipelineSchedule = ReturnType<typeof createPipelineSchedule>;
