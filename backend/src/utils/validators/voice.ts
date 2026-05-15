import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const url = z.string().trim().url().max(2048);
const json = z.record(z.string(), z.any());
const numberValue = z.union([z.number(), z.string().trim().transform(v => Number(v))]).pipe(z.number().finite());
const intValue = numberValue.transform(v => Math.floor(v)).pipe(z.number().int());

export const roomSchema = z.object({ roomId: id });

export const seatSchema = z.object({
  roomId: id.optional(),
  seatIndex: intValue.refine(v => v >= 0 && v <= 9).optional()
});

export const chatSchema = z.object({
  content: z.string().trim().max(500).optional(),
  mediaUrl: url.optional(),
  mediaType: z.enum(["IMAGE", "VIDEO", "AUDIO", "FILE", "GIF", "NONE"]).optional(),
  replyToId: id.optional(),
  clientId: z.string().trim().max(128).optional()
}).refine(v => Boolean(v.content || v.mediaUrl), "Message required");

export const giftSchema = z.object({
  toId: id,
  giftId: z.string().trim().min(1).max(80),
  amount: numberValue.refine(v => v >= 1 && v <= 100000)
});

export const hostActionSchema = z.object({
  action: z.enum(["mute", "unmute", "kick", "promote_mod", "remove_mod", "lock_room", "unlock_room", "close_room", "transfer_host", "raise_hand", "lower_hand", "launch_poll", "pause_music", "resume_music", "next_music"]),
  targetId: id.optional(),
  question: z.string().trim().max(160).optional(),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(6).optional()
});

export const roomActionSchema = z.object({
  roomId: id,
  action: z.enum(["mute", "unmute", "kick", "promote", "promote_mod", "remove_mod", "close", "close_room", "lock_room", "unlock_room", "pause_music", "resume_music", "next_music", "transfer_host", "lower_hand"]),
  targetId: id.optional()
});

export const pollVoteSchema = z.object({
  pollId: z.string().trim().min(1).max(120),
  optionIndex: intValue.refine(v => v >= 0 && v <= 20)
});

export const createRoomSchema = z.object({
  title: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  topic: z.string().trim().max(80).optional(),
  coverUrl: z.union([url, z.literal(""), z.null()]).optional(),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional().default("PUBLIC"),
  maxSeats: intValue.refine(v => v >= 1 && v <= 10).optional().default(10),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional().default([]),
  language: z.string().trim().min(2).max(20).optional(),
  category: z.string().trim().max(80).optional(),
  isRecordingEnabled: z.boolean().optional().default(false),
  allowGifts: z.boolean().optional().default(true),
  allowChat: z.boolean().optional().default(true),
  settings: json.optional()
});

export const updateRoomSchema = createRoomSchema.partial().extend({ roomId: id });
