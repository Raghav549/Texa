import { Worker } from "bullmq";
import { redis } from "../config/redis";

export type AnalyticsJobName = "track_event" | "flush_analytics" | "aggregate_metrics" | string;
export type AnalyticsJobData = Record<string, any>;

const connection = redis as any;

export const analyticsWorker = new Worker<AnalyticsJobData, any, AnalyticsJobName>(
  "analytics",
  async job => {
    return { ok: true, jobId: job.id, name: job.name, processedAt: new Date().toISOString() };
  },
  { connection }
);

analyticsWorker.on("failed", (job, error) => {
  console.error("analytics worker failed", job?.id, error?.message);
});
