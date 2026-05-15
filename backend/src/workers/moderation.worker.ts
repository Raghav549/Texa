import { Worker } from "bullmq";
import { redis } from "../config/redis";

export type ModerationJobName = "moderate_content" | "scan_media" | "review_report" | string;
export type ModerationJobData = Record<string, any>;

const connection = redis as any;

export const moderationWorker = new Worker<ModerationJobData, any, ModerationJobName>(
  "moderation",
  async job => {
    return { ok: true, jobId: job.id, name: job.name, processedAt: new Date().toISOString() };
  },
  { connection }
);

moderationWorker.on("failed", (job, error) => {
  console.error("moderation worker failed", job?.id, error?.message);
});
