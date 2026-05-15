import { Queue, Worker, QueueEvents, JobsOptions, WorkerOptions, QueueOptions, Job } from "bullmq";
import crypto from "crypto";
import { redis } from "../config/redis";
import { processMediaWorker } from "./media.worker";
import { moderationWorker } from "./moderation.worker";
import { analyticsWorker } from "./analytics.worker";

export type QueueName = "media_processing" | "ai_moderation" | "analytics_tracking";
export type MediaJobName = "process" | "thumbnail" | "transcode" | "cleanup";
export type ModerationJobName = "scan" | "rescan" | "resolve";
export type AnalyticsJobName = "track" | "aggregate" | "flush";

export interface MediaProcessingJobData {
  itemId: string;
  userId: string;
  type: "reel" | "story" | "product" | "avatar" | "banner" | "message" | "other";
  inputPath?: string;
  inputUrl?: string;
  outputDir?: string;
  mimeType?: string;
  originalName?: string;
  metadata?: Record<string, any>;
}

export interface ModerationJobData {
  itemId?: string;
  userId: string;
  type: "image" | "video" | "text" | "user" | "store" | "product" | "comment" | "message";
  content: string;
  source?: string;
  metadata?: Record<string, any>;
}

export interface AnalyticsJobData {
  userId?: string;
  anonymousId?: string;
  type: "view" | "like" | "comment" | "share" | "save" | "follow" | "purchase" | "add_to_cart" | "checkout_start" | "ad_impression" | "ad_click" | "ad_conversion" | "story_view" | "reel_watch" | "search" | "custom";
  targetType?: string;
  targetId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  timestamp?: string | Date;
}

type QueueBundle = {
  queue: Queue<any, any, any>;
  events: QueueEvents;
  worker: Worker<any, any, any>;
};

const QUEUE_NAMES: QueueName[] = ["media_processing", "ai_moderation", "analytics_tracking"];
const connection = redis.duplicate({ maxRetriesPerRequest: null, enableReadyCheck: false });
const queueConnection = redis.duplicate({ maxRetriesPerRequest: null, enableReadyCheck: false });
const eventConnection = redis.duplicate({ maxRetriesPerRequest: null, enableReadyCheck: false });

const defaultQueueOptions: QueueOptions = {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 60 * 60 * 24, count: 500 },
    removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 }
  }
};

const defaultWorkerOptions: WorkerOptions = {
  connection,
  lockDuration: 30000,
  stalledInterval: 30000,
  maxStalledCount: 2,
  autorun: true
};

const sanitizeQueueNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const hashPayload = (payload: unknown) => crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex").slice(0, 24);
const compactObject = <T extends Record<string, any>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

const mergeJobOptions = (base: JobsOptions, override?: JobsOptions): JobsOptions => compactObject({
  ...base,
  ...override,
  backoff: override?.backoff ?? base.backoff,
  removeOnComplete: override?.removeOnComplete ?? base.removeOnComplete,
  removeOnFail: override?.removeOnFail ?? base.removeOnFail
});

const createJobId = (prefix: string, data: Record<string, any>, unique = false) => {
  if (unique) return `${prefix}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`;
  const parts = [prefix, data.itemId, data.targetId, data.userId, data.anonymousId, data.type, data.sessionId, hashPayload(data.metadata)]
    .filter(Boolean)
    .map(value => String(value).replace(/[^a-zA-Z0-9:_-]/g, "_"));
  return parts.length ? parts.join(":") : `${prefix}:${hashPayload(data)}`;
};

const ensureMediaJob = (jobData: MediaProcessingJobData, label: string, requireInput = true) => {
  if (!jobData?.userId) throw new Error(`${label} job requires userId`);
  if (!jobData?.itemId) throw new Error(`${label} job requires itemId`);
  if (requireInput && !jobData?.inputPath && !jobData?.inputUrl) throw new Error(`${label} job requires inputPath or inputUrl`);
};

const ensureModerationJob = (jobData: ModerationJobData, label: string) => {
  if (!jobData?.userId) throw new Error(`${label} job requires userId`);
  if (!jobData?.type) throw new Error(`${label} job requires type`);
  if (!jobData?.content) throw new Error(`${label} job requires content`);
};

const ensureAnalyticsJob = (jobData: AnalyticsJobData, label: string) => {
  if (!jobData?.type) throw new Error(`${label} job requires type`);
};

export const mediaQueue = new Queue<MediaProcessingJobData, any, MediaJobName>("media_processing", { ...defaultQueueOptions, defaultJobOptions: { ...defaultQueueOptions.defaultJobOptions, attempts: 4, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } } });
export const moderationQueue = new Queue<ModerationJobData, any, ModerationJobName>("ai_moderation", { ...defaultQueueOptions, defaultJobOptions: { ...defaultQueueOptions.defaultJobOptions, attempts: 3, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } } });
export const analyticsQueue = new Queue<AnalyticsJobData, any, AnalyticsJobName>("analytics_tracking", { ...defaultQueueOptions, defaultJobOptions: { ...defaultQueueOptions.defaultJobOptions, attempts: 5, removeOnComplete: { age: 60 * 60 * 12, count: 2000 }, removeOnFail: { age: 60 * 60 * 24 * 3, count: 2000 } } });

export const mediaQueueEvents = new QueueEvents("media_processing", { connection: eventConnection.duplicate() });
export const moderationQueueEvents = new QueueEvents("ai_moderation", { connection: eventConnection.duplicate() });
export const analyticsQueueEvents = new QueueEvents("analytics_tracking", { connection: eventConnection.duplicate() });

export const mediaWorker = new Worker<MediaProcessingJobData, any, MediaJobName>("media_processing", async (job: Job<MediaProcessingJobData, any, MediaJobName>) => processMediaWorker(job as any), { ...defaultWorkerOptions, concurrency: sanitizeQueueNumber(process.env.MEDIA_WORKER_CONCURRENCY, 2, 1, 10), lockDuration: 1000 * 60 * 10 });
export const moderationWorkerInstance = new Worker<ModerationJobData, any, ModerationJobName>("ai_moderation", async (job: Job<ModerationJobData, any, ModerationJobName>) => moderationWorker(job as any), { ...defaultWorkerOptions, concurrency: sanitizeQueueNumber(process.env.MODERATION_WORKER_CONCURRENCY, 2, 1, 10), lockDuration: 1000 * 60 * 3 });
export const analyticsWorkerInstance = new Worker<AnalyticsJobData, any, AnalyticsJobName>("analytics_tracking", async (job: Job<AnalyticsJobData, any, AnalyticsJobName>) => analyticsWorker(job as any), { ...defaultWorkerOptions, concurrency: sanitizeQueueNumber(process.env.ANALYTICS_WORKER_CONCURRENCY, 10, 1, 50), lockDuration: 1000 * 60 });

const bundles: Record<QueueName, QueueBundle> = {
  media_processing: { queue: mediaQueue, events: mediaQueueEvents, worker: mediaWorker },
  ai_moderation: { queue: moderationQueue, events: moderationQueueEvents, worker: moderationWorkerInstance },
  analytics_tracking: { queue: analyticsQueue, events: analyticsQueueEvents, worker: analyticsWorkerInstance }
};

export function enqueueMediaProcessing(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  ensureMediaJob(jobData, "Media");
  return mediaQueue.add("process", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("media", jobData), priority: 5, attempts: 4, backoff: { type: "exponential", delay: 3000 }, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } }, options));
}

export function enqueueThumbnailProcessing(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  ensureMediaJob(jobData, "Thumbnail");
  return mediaQueue.add("thumbnail", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("thumbnail", jobData), priority: 3, attempts: 3, backoff: { type: "exponential", delay: 1500 }, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } }, options));
}

export function enqueueTranscodeProcessing(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  ensureMediaJob(jobData, "Transcode");
  return mediaQueue.add("transcode", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("transcode", jobData), priority: 2, attempts: 4, backoff: { type: "exponential", delay: 3000 }, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } }, options));
}

export function enqueueMediaCleanup(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  ensureMediaJob(jobData, "Cleanup", false);
  return mediaQueue.add("cleanup", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("cleanup", jobData), priority: 10, attempts: 2, delay: 1000 * 60 * 10, removeOnComplete: { age: 60 * 60 * 12, count: 500 }, removeOnFail: { age: 60 * 60 * 24 * 3, count: 500 } }, options));
}

export function enqueueModeration(jobData: ModerationJobData, options: JobsOptions = {}) {
  ensureModerationJob(jobData, "Moderation");
  return moderationQueue.add("scan", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("moderation", jobData), priority: 2, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } }, options));
}

export function enqueueModerationRescan(jobData: ModerationJobData, options: JobsOptions = {}) {
  ensureModerationJob(jobData, "Moderation rescan");
  return moderationQueue.add("rescan", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("moderation-rescan", jobData, true), priority: 1, attempts: 2, backoff: { type: "exponential", delay: 1500 }, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } }, options));
}

export function enqueueModerationResolve(jobData: ModerationJobData, options: JobsOptions = {}) {
  ensureModerationJob(jobData, "Moderation resolve");
  return moderationQueue.add("resolve", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("moderation-resolve", jobData, true), priority: 1, attempts: 2, removeOnComplete: { age: 60 * 60 * 24, count: 300 }, removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 } }, options));
}

export function enqueueAnalytics(jobData: AnalyticsJobData, options: JobsOptions = {}) {
  ensureAnalyticsJob(jobData, "Analytics");
  const payload: AnalyticsJobData = { ...jobData, timestamp: jobData.timestamp || new Date() };
  return analyticsQueue.add("track", payload, mergeJobOptions({ jobId: options.jobId, priority: 8, attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: { age: 60 * 60 * 12, count: 2000 }, removeOnFail: { age: 60 * 60 * 24 * 3, count: 2000 } }, options));
}

export function enqueueAnalyticsAggregate(jobData: AnalyticsJobData, options: JobsOptions = {}) {
  ensureAnalyticsJob(jobData, "Analytics aggregate");
  return analyticsQueue.add("aggregate", jobData, mergeJobOptions({ jobId: options.jobId || createJobId("analytics-aggregate", jobData), priority: 6, attempts: 4, backoff: { type: "exponential", delay: 1500 }, removeOnComplete: { age: 60 * 60 * 12, count: 1000 }, removeOnFail: { age: 60 * 60 * 24 * 3, count: 1000 } }, options));
}

export function enqueueAnalyticsFlush(jobData: AnalyticsJobData, options: JobsOptions = {}) {
  ensureAnalyticsJob(jobData, "Analytics flush");
  return analyticsQueue.add("flush", { ...jobData, timestamp: jobData.timestamp || new Date() }, mergeJobOptions({ jobId: options.jobId || createJobId("analytics-flush", jobData, true), priority: 4, attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: { age: 60 * 60 * 12, count: 1000 }, removeOnFail: { age: 60 * 60 * 24 * 3, count: 1000 } }, options));
}

export async function getQueueHealth() {
  const entries = await Promise.all(QUEUE_NAMES.map(async name => {
    const bundle = bundles[name];
    const [counts, paused, waiting, active, delayed, failed, completed] = await Promise.all([
      bundle.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused", "prioritized", "waiting-children"),
      bundle.queue.isPaused(),
      bundle.queue.getWaitingCount(),
      bundle.queue.getActiveCount(),
      bundle.queue.getDelayedCount(),
      bundle.queue.getFailedCount(),
      bundle.queue.getCompletedCount()
    ]);
    return [name, { paused, counts, waiting, active, delayed, failed, completed }] as const;
  }));
  return Object.fromEntries(entries) as Record<QueueName, any>;
}

export async function pauseQueues(names?: QueueName[]) {
  const selected = names?.length ? names : QUEUE_NAMES;
  await Promise.all(selected.map(name => bundles[name].queue.pause()));
  return getQueueHealth();
}

export async function resumeQueues(names?: QueueName[]) {
  const selected = names?.length ? names : QUEUE_NAMES;
  await Promise.all(selected.map(name => bundles[name].queue.resume()));
  return getQueueHealth();
}

export async function drainQueues(names?: QueueName[], delayed = true) {
  const selected = names?.length ? names : QUEUE_NAMES;
  await Promise.all(selected.map(name => bundles[name].queue.drain(delayed)));
  return getQueueHealth();
}

export async function cleanQueues(graceMs = 1000 * 60 * 60 * 24) {
  await Promise.all([
    mediaQueue.clean(graceMs, 500, "completed"),
    mediaQueue.clean(graceMs * 7, 500, "failed"),
    moderationQueue.clean(graceMs, 500, "completed"),
    moderationQueue.clean(graceMs * 7, 500, "failed"),
    analyticsQueue.clean(graceMs / 2, 1000, "completed"),
    analyticsQueue.clean(graceMs * 3, 1000, "failed")
  ]);
  return getQueueHealth();
}

export async function retryFailedJobs(name: QueueName, limit = 100) {
  const queue = bundles[name].queue;
  const failedJobs = await queue.getFailed(0, Math.max(0, limit - 1));
  await Promise.all(failedJobs.map(job => job.retry().catch(() => null)));
  return getQueueHealth();
}

export async function obliterateQueues(names?: QueueName[]) {
  const selected = names?.length ? names : QUEUE_NAMES;
  await Promise.all(selected.map(name => bundles[name].queue.obliterate({ force: true })));
  return getQueueHealth();
}

function bindWorkerLogs(worker: Worker<any, any, any>, name: QueueName) {
  worker.on("completed", job => {
    console.log(`[Queue:${name}] completed`, { id: job.id, name: job.name, attemptsMade: job.attemptsMade, finishedOn: job.finishedOn });
  });
  worker.on("failed", (job, error) => {
    console.error(`[Queue:${name}] failed`, { id: job?.id, name: job?.name, attemptsMade: job?.attemptsMade, failedReason: job?.failedReason, error: error.message });
  });
  worker.on("stalled", jobId => {
    console.warn(`[Queue:${name}] stalled`, { jobId });
  });
  worker.on("error", error => {
    console.error(`[Queue:${name}] worker error`, { message: error.message, stack: error.stack });
  });
  worker.on("closed", () => {
    console.log(`[Queue:${name}] worker closed`);
  });
}

function bindQueueEvents(events: QueueEvents, name: QueueName) {
  events.on("completed", ({ jobId, returnvalue }) => {
    console.log(`[QueueEvents:${name}] completed`, { jobId, returnvalue });
  });
  events.on("failed", ({ jobId, failedReason }) => {
    console.error(`[QueueEvents:${name}] failed`, { jobId, failedReason });
  });
  events.on("progress", ({ jobId, data }) => {
    console.log(`[QueueEvents:${name}] progress`, { jobId, data });
  });
  events.on("stalled", ({ jobId }) => {
    console.warn(`[QueueEvents:${name}] stalled`, { jobId });
  });
  events.on("error", error => {
    console.error(`[QueueEvents:${name}] error`, { message: error.message, stack: error.stack });
  });
}

bindWorkerLogs(mediaWorker, "media_processing");
bindWorkerLogs(moderationWorkerInstance, "ai_moderation");
bindWorkerLogs(analyticsWorkerInstance, "analytics_tracking");
bindQueueEvents(mediaQueueEvents, "media_processing");
bindQueueEvents(moderationQueueEvents, "ai_moderation");
bindQueueEvents(analyticsQueueEvents, "analytics_tracking");

let closingPromise: Promise<void> | null = null;

export async function closeQueues() {
  if (closingPromise) return closingPromise;
  closingPromise = Promise.allSettled([
    mediaWorker.close(),
    moderationWorkerInstance.close(),
    analyticsWorkerInstance.close(),
    mediaQueueEvents.close(),
    moderationQueueEvents.close(),
    analyticsQueueEvents.close(),
    mediaQueue.close(),
    moderationQueue.close(),
    analyticsQueue.close(),
    eventConnection.quit(),
    connection.quit(),
    queueConnection.quit()
  ]).then(() => undefined);
  return closingPromise;
}

const shutdown = async () => {
  try {
    await closeQueues();
  } finally {
    process.exit(0);
  }
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
