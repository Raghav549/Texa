import { Queue, Worker, QueueEvents, JobsOptions, WorkerOptions, QueueOptions, Job } from 'bullmq';
import { redis } from '../config/redis';
import { processMediaWorker } from './media.worker';
import { moderationWorker } from './moderation.worker';
import { analyticsWorker } from './analytics.worker';

type QueueName = 'media_processing' | 'ai_moderation' | 'analytics_tracking';

type MediaJobName = 'process' | 'thumbnail' | 'transcode' | 'cleanup';
type ModerationJobName = 'scan' | 'rescan' | 'resolve';
type AnalyticsJobName = 'track' | 'aggregate' | 'flush';

export interface MediaProcessingJobData {
  itemId: string;
  userId: string;
  type: 'reel' | 'story' | 'product' | 'avatar' | 'banner' | 'message' | 'other';
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
  type: 'image' | 'video' | 'text' | 'user' | 'store' | 'product' | 'comment' | 'message';
  content: string;
  source?: string;
  metadata?: Record<string, any>;
}

export interface AnalyticsJobData {
  userId?: string;
  anonymousId?: string;
  type:
    | 'view'
    | 'like'
    | 'comment'
    | 'share'
    | 'save'
    | 'follow'
    | 'purchase'
    | 'add_to_cart'
    | 'checkout_start'
    | 'ad_impression'
    | 'ad_click'
    | 'ad_conversion'
    | 'story_view'
    | 'reel_watch'
    | 'search'
    | 'custom';
  targetType?: string;
  targetId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  timestamp?: string | Date;
}

const connection = redis.duplicate({
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

const queueConnection = redis.duplicate({
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

const defaultQueueOptions: QueueOptions = {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: {
      age: 60 * 60 * 24,
      count: 500
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 7,
      count: 1000
    }
  }
};

const defaultWorkerOptions: WorkerOptions = {
  connection,
  lockDuration: 30000,
  stalledInterval: 30000,
  maxStalledCount: 2,
  autorun: true
};

export const mediaQueue = new Queue<MediaProcessingJobData, any, MediaJobName>('media_processing', {
  ...defaultQueueOptions,
  defaultJobOptions: {
    ...defaultQueueOptions.defaultJobOptions,
    attempts: 4,
    timeout: 1000 * 60 * 20,
    removeOnComplete: {
      age: 60 * 60 * 24,
      count: 300
    }
  }
});

export const moderationQueue = new Queue<ModerationJobData, any, ModerationJobName>('ai_moderation', {
  ...defaultQueueOptions,
  defaultJobOptions: {
    ...defaultQueueOptions.defaultJobOptions,
    attempts: 3,
    timeout: 1000 * 60 * 5,
    removeOnComplete: {
      age: 60 * 60 * 24,
      count: 300
    }
  }
});

export const analyticsQueue = new Queue<AnalyticsJobData, any, AnalyticsJobName>('analytics_tracking', {
  ...defaultQueueOptions,
  defaultJobOptions: {
    ...defaultQueueOptions.defaultJobOptions,
    attempts: 5,
    timeout: 1000 * 60,
    removeOnComplete: {
      age: 60 * 60 * 12,
      count: 2000
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 3,
      count: 2000
    }
  }
});

export const mediaQueueEvents = new QueueEvents('media_processing', { connection: connection.duplicate() });
export const moderationQueueEvents = new QueueEvents('ai_moderation', { connection: connection.duplicate() });
export const analyticsQueueEvents = new QueueEvents('analytics_tracking', { connection: connection.duplicate() });

export const mediaWorker = new Worker<MediaProcessingJobData, any, MediaJobName>(
  'media_processing',
  async (job: Job<MediaProcessingJobData, any, MediaJobName>) => processMediaWorker(job),
  {
    ...defaultWorkerOptions,
    concurrency: Number(process.env.MEDIA_WORKER_CONCURRENCY || 2),
    lockDuration: 1000 * 60 * 10
  }
);

export const moderationWorkerInstance = new Worker<ModerationJobData, any, ModerationJobName>(
  'ai_moderation',
  async (job: Job<ModerationJobData, any, ModerationJobName>) => moderationWorker(job),
  {
    ...defaultWorkerOptions,
    concurrency: Number(process.env.MODERATION_WORKER_CONCURRENCY || 2),
    lockDuration: 1000 * 60 * 3
  }
);

export const analyticsWorkerInstance = new Worker<AnalyticsJobData, any, AnalyticsJobName>(
  'analytics_tracking',
  async (job: Job<AnalyticsJobData, any, AnalyticsJobName>) => analyticsWorker(job),
  {
    ...defaultWorkerOptions,
    concurrency: Number(process.env.ANALYTICS_WORKER_CONCURRENCY || 10),
    lockDuration: 1000 * 60
  }
);

function createJobId(prefix: string, data: Record<string, any>) {
  const base = [
    prefix,
    data.itemId,
    data.targetId,
    data.userId,
    data.anonymousId,
    data.type,
    data.sessionId
  ]
    .filter(Boolean)
    .join(':');

  return base || `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizeJobOptions(options?: JobsOptions): JobsOptions {
  return {
    attempts: options?.attempts,
    backoff: options?.backoff,
    delay: options?.delay,
    priority: options?.priority,
    lifo: options?.lifo,
    removeOnComplete: options?.removeOnComplete,
    removeOnFail: options?.removeOnFail,
    jobId: options?.jobId,
    timeout: options?.timeout
  };
}

export function enqueueMediaProcessing(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  if (!jobData?.userId) throw new Error('Media job requires userId');
  if (!jobData?.itemId) throw new Error('Media job requires itemId');
  if (!jobData?.inputPath && !jobData?.inputUrl) throw new Error('Media job requires inputPath or inputUrl');

  return mediaQueue.add('process', jobData, {
    jobId: options.jobId || createJobId('media', jobData),
    priority: options.priority ?? 5,
    attempts: options.attempts ?? 4,
    backoff: options.backoff ?? {
      type: 'exponential',
      delay: 3000
    },
    removeOnComplete: options.removeOnComplete ?? {
      age: 60 * 60 * 24,
      count: 300
    },
    removeOnFail: options.removeOnFail ?? {
      age: 60 * 60 * 24 * 7,
      count: 1000
    },
    timeout: options.timeout ?? 1000 * 60 * 20,
    ...normalizeJobOptions(options)
  });
}

export function enqueueThumbnailProcessing(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  if (!jobData?.userId) throw new Error('Thumbnail job requires userId');
  if (!jobData?.itemId) throw new Error('Thumbnail job requires itemId');
  if (!jobData?.inputPath && !jobData?.inputUrl) throw new Error('Thumbnail job requires inputPath or inputUrl');

  return mediaQueue.add('thumbnail', jobData, {
    jobId: options.jobId || createJobId('thumbnail', jobData),
    priority: options.priority ?? 3,
    attempts: options.attempts ?? 3,
    backoff: options.backoff ?? {
      type: 'exponential',
      delay: 1500
    },
    timeout: options.timeout ?? 1000 * 60 * 5,
    ...normalizeJobOptions(options)
  });
}

export function enqueueMediaCleanup(jobData: MediaProcessingJobData, options: JobsOptions = {}) {
  if (!jobData?.userId) throw new Error('Cleanup job requires userId');
  if (!jobData?.itemId) throw new Error('Cleanup job requires itemId');

  return mediaQueue.add('cleanup', jobData, {
    jobId: options.jobId || createJobId('cleanup', jobData),
    priority: options.priority ?? 10,
    attempts: options.attempts ?? 2,
    delay: options.delay ?? 1000 * 60 * 10,
    timeout: options.timeout ?? 1000 * 60 * 3,
    ...normalizeJobOptions(options)
  });
}

export function enqueueModeration(jobData: ModerationJobData, options: JobsOptions = {}) {
  if (!jobData?.userId) throw new Error('Moderation job requires userId');
  if (!jobData?.type) throw new Error('Moderation job requires type');
  if (!jobData?.content) throw new Error('Moderation job requires content');

  return moderationQueue.add('scan', jobData, {
    jobId: options.jobId || createJobId('moderation', jobData),
    priority: options.priority ?? 2,
    attempts: options.attempts ?? 3,
    backoff: options.backoff ?? {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: options.removeOnComplete ?? {
      age: 60 * 60 * 24,
      count: 300
    },
    timeout: options.timeout ?? 1000 * 60 * 5,
    ...normalizeJobOptions(options)
  });
}

export function enqueueModerationRescan(jobData: ModerationJobData, options: JobsOptions = {}) {
  if (!jobData?.userId) throw new Error('Moderation rescan job requires userId');
  if (!jobData?.content) throw new Error('Moderation rescan job requires content');

  return moderationQueue.add('rescan', jobData, {
    jobId: options.jobId || createJobId('moderation-rescan', jobData),
    priority: options.priority ?? 1,
    attempts: options.attempts ?? 2,
    timeout: options.timeout ?? 1000 * 60 * 5,
    ...normalizeJobOptions(options)
  });
}

export function enqueueAnalytics(jobData: AnalyticsJobData, options: JobsOptions = {}) {
  if (!jobData?.type) throw new Error('Analytics job requires type');

  const payload: AnalyticsJobData = {
    ...jobData,
    timestamp: jobData.timestamp || new Date()
  };

  return analyticsQueue.add('track', payload, {
    jobId: options.jobId,
    priority: options.priority ?? 8,
    attempts: options.attempts ?? 5,
    backoff: options.backoff ?? {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: options.removeOnComplete ?? {
      age: 60 * 60 * 12,
      count: 2000
    },
    timeout: options.timeout ?? 1000 * 60,
    ...normalizeJobOptions(options)
  });
}

export function enqueueAnalyticsAggregate(jobData: AnalyticsJobData, options: JobsOptions = {}) {
  if (!jobData?.type) throw new Error('Analytics aggregate job requires type');

  return analyticsQueue.add('aggregate', jobData, {
    jobId: options.jobId || createJobId('analytics-aggregate', jobData),
    priority: options.priority ?? 6,
    attempts: options.attempts ?? 4,
    timeout: options.timeout ?? 1000 * 60 * 3,
    ...normalizeJobOptions(options)
  });
}

export async function getQueueHealth() {
  const [
    mediaCounts,
    moderationCounts,
    analyticsCounts,
    mediaPaused,
    moderationPaused,
    analyticsPaused
  ] = await Promise.all([
    mediaQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
    moderationQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
    analyticsQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
    mediaQueue.isPaused(),
    moderationQueue.isPaused(),
    analyticsQueue.isPaused()
  ]);

  return {
    media_processing: {
      paused: mediaPaused,
      counts: mediaCounts
    },
    ai_moderation: {
      paused: moderationPaused,
      counts: moderationCounts
    },
    analytics_tracking: {
      paused: analyticsPaused,
      counts: analyticsCounts
    }
  };
}

export async function pauseQueues(names?: QueueName[]) {
  const selected = names?.length ? names : ['media_processing', 'ai_moderation', 'analytics_tracking'];

  await Promise.all(
    selected.map(name => {
      if (name === 'media_processing') return mediaQueue.pause();
      if (name === 'ai_moderation') return moderationQueue.pause();
      return analyticsQueue.pause();
    })
  );

  return getQueueHealth();
}

export async function resumeQueues(names?: QueueName[]) {
  const selected = names?.length ? names : ['media_processing', 'ai_moderation', 'analytics_tracking'];

  await Promise.all(
    selected.map(name => {
      if (name === 'media_processing') return mediaQueue.resume();
      if (name === 'ai_moderation') return moderationQueue.resume();
      return analyticsQueue.resume();
    })
  );

  return getQueueHealth();
}

export async function drainQueues(names?: QueueName[]) {
  const selected = names?.length ? names : ['media_processing', 'ai_moderation', 'analytics_tracking'];

  await Promise.all(
    selected.map(name => {
      if (name === 'media_processing') return mediaQueue.drain();
      if (name === 'ai_moderation') return moderationQueue.drain();
      return analyticsQueue.drain();
    })
  );

  return getQueueHealth();
}

export async function cleanQueues(graceMs = 1000 * 60 * 60 * 24) {
  await Promise.all([
    mediaQueue.clean(graceMs, 500, 'completed'),
    mediaQueue.clean(graceMs * 7, 500, 'failed'),
    moderationQueue.clean(graceMs, 500, 'completed'),
    moderationQueue.clean(graceMs * 7, 500, 'failed'),
    analyticsQueue.clean(graceMs / 2, 1000, 'completed'),
    analyticsQueue.clean(graceMs * 3, 1000, 'failed')
  ]);

  return getQueueHealth();
}

function bindWorkerLogs(worker: Worker, name: QueueName) {
  worker.on('completed', job => {
    console.log(`[Queue:${name}] completed`, {
      id: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade
    });
  });

  worker.on('failed', (job, error) => {
    console.error(`[Queue:${name}] failed`, {
      id: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
      error: error.message
    });
  });

  worker.on('stalled', jobId => {
    console.warn(`[Queue:${name}] stalled`, { jobId });
  });

  worker.on('error', error => {
    console.error(`[Queue:${name}] worker error`, error);
  });
}

function bindQueueEvents(events: QueueEvents, name: QueueName) {
  events.on('completed', ({ jobId }) => {
    console.log(`[QueueEvents:${name}] completed`, { jobId });
  });

  events.on('failed', ({ jobId, failedReason }) => {
    console.error(`[QueueEvents:${name}] failed`, { jobId, failedReason });
  });

  events.on('progress', ({ jobId, data }) => {
    console.log(`[QueueEvents:${name}] progress`, { jobId, data });
  });

  events.on('error', error => {
    console.error(`[QueueEvents:${name}] error`, error);
  });
}

bindWorkerLogs(mediaWorker, 'media_processing');
bindWorkerLogs(moderationWorkerInstance, 'ai_moderation');
bindWorkerLogs(analyticsWorkerInstance, 'analytics_tracking');

bindQueueEvents(mediaQueueEvents, 'media_processing');
bindQueueEvents(moderationQueueEvents, 'ai_moderation');
bindQueueEvents(analyticsQueueEvents, 'analytics_tracking');

export async function closeQueues() {
  await Promise.allSettled([
    mediaWorker.close(),
    moderationWorkerInstance.close(),
    analyticsWorkerInstance.close(),
    mediaQueueEvents.close(),
    moderationQueueEvents.close(),
    analyticsQueueEvents.close(),
    mediaQueue.close(),
    moderationQueue.close(),
    analyticsQueue.close(),
    connection.quit(),
    queueConnection.quit()
  ]);
}

process.once('SIGTERM', async () => {
  await closeQueues();
  process.exit(0);
});

process.once('SIGINT', async () => {
  await closeQueues();
  process.exit(0);
});
