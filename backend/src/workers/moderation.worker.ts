import { Job } from "bullmq";

export type ModerationJobName = "scan" | "rescan" | "resolve";
export type ModerationJobData = {
  itemId?: string;
  userId: string;
  type: "image" | "video" | "text" | "user" | "store" | "product" | "comment" | "message";
  content: string;
  source?: string;
  metadata?: Record<string, any>;
};

export async function moderationWorker(job: Job<ModerationJobData, any, ModerationJobName>) {
  const data = job.data;
  if (!data?.userId) throw new Error("Moderation job requires userId");
  if (!data?.type) throw new Error("Moderation job requires type");
  if (!data?.content) throw new Error("Moderation job requires content");
  return {
    ok: true,
    jobId: job.id,
    name: job.name,
    itemId: data.itemId || null,
    userId: data.userId,
    type: data.type,
    processedAt: new Date().toISOString()
  };
}
