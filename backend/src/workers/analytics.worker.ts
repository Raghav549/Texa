import { Job } from "bullmq";

export type AnalyticsJobName = "track" | "aggregate" | "flush";
export type AnalyticsJobData = {
  userId?: string;
  anonymousId?: string;
  type: string;
  targetType?: string;
  targetId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  timestamp?: string | Date;
};

export async function analyticsWorker(job: Job<AnalyticsJobData, any, AnalyticsJobName>) {
  const data = job.data;
  if (!data?.type) throw new Error("Analytics job requires type");
  return {
    ok: true,
    jobId: job.id,
    name: job.name,
    type: data.type,
    userId: data.userId || null,
    targetType: data.targetType || null,
    targetId: data.targetId || null,
    processedAt: new Date().toISOString()
  };
}
