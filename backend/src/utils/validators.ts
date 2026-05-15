import { z } from "zod";

const objectIdLike = z.string().trim().min(1).max(128);
const optionalObjectIdLike = objectIdLike.optional();
const usernameRegex = /^[a-z0-9_]{3,30}$/;
const phoneRegex = /^\+[1-9]\d{1,14}$/;
const hexColorRegex = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const urlSchema = z.string().trim().url().max(2048);
const nullableUrlSchema = z.union([urlSchema, z.literal(""), z.null()]).transform(value => (value ? value : null));
const safeText = (min = 1, max = 5000) => z.string().trim().min(min).max(max);
const optionalSafeText = (max = 5000) => z.string().trim().max(max).optional();
const boolish = z.union([
  z.boolean(),
  z.string().trim().transform(value => ["true", "1", "yes", "on"].includes(value.toLowerCase()))
]);
const numberish = () =>
  z.union([
    z.number(),
    z.string().trim().transform(value => Number(value))
  ]).pipe(z.number().finite());
const intish = () => numberish().transform(value => Math.floor(value)).pipe(z.number().int());
const jsonRecord = z.record(z.string(), z.any());

export const idSchema = objectIdLike;

export const paginationSchema = z.object({
  page: intish().min(1).max(100000).optional().default(1),
  limit: intish().min(1).max(100).optional().default(20),
  cursor: optionalObjectIdLike,
  sortBy: z.string().trim().max(80).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc")
});

export const searchSchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  type: z.string().trim().max(60).optional(),
  category: z.string().trim().max(80).optional(),
  cursor: optionalObjectIdLike,
  limit: intish().min(1).max(100).optional().default(20)
});

export const signupSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  username: z.string().trim().toLowerCase().regex(usernameRegex),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
  dob: z.string().trim().refine(value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    const age = now.getFullYear() - date.getFullYear();
    const monthDiff = now.getMonth() - date.getMonth();
    const dayDiff = now.getDate() - date.getDate();
    const exactAge = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? age - 1 : age;
    return exactAge >= 13 && exactAge <= 120;
  }, "Invalid date of birth"),
  bio: z.string().trim().max(160).optional(),
  phone: z.string().trim().regex(phoneRegex).optional(),
  avatarUrl: nullableUrlSchema.optional(),
  referralCode: z.string().trim().max(80).optional(),
  deviceId: z.string().trim().max(160).optional(),
  fcmToken: z.string().trim().max(512).optional()
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  deviceId: z.string().trim().max(160).optional(),
  fcmToken: z.string().trim().max(512).optional()
});

export const usernameSchema = z.object({
  username: z.string().trim().toLowerCase().regex(usernameRegex)
});

export const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254)
});

export const phoneSchema = z.object({
  phone: z.string().trim().regex(phoneRegex)
});

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254)
});

export const passwordResetSchema = z.object({
  token: z.string().trim().min(16).max(512),
  password: z.string().min(8).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/)
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/)
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(16).max(2048)
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(80).optional(),
  username: z.string().trim().toLowerCase().regex(usernameRegex).optional(),
  bio: z.string().trim().max(160).optional(),
  avatarUrl: nullableUrlSchema.optional(),
  coverUrl: nullableUrlSchema.optional(),
  bannerUrl: nullableUrlSchema.optional(),
  website: nullableUrlSchema.optional(),
  location: z.string().trim().max(120).optional(),
  gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
  dob: z.string().trim().optional(),
  isPrivate: z.boolean().optional(),
  theme: z.string().trim().max(40).optional(),
  accentColor: z.string().trim().regex(hexColorRegex).optional()
});

export const followSchema = z.object({
  userId: objectIdLike
});

export const blockUserSchema = z.object({
  userId: objectIdLike,
  reason: z.string().trim().max(300).optional()
});

export const conversationCreateSchema = z.object({
  type: z.enum(["DIRECT", "GROUP", "SUPPORT", "ROOM"]).optional().default("DIRECT"),
  participantIds: z.array(objectIdLike).min(1).max(100),
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  avatarUrl: nullableUrlSchema.optional(),
  settings: jsonRecord.optional(),
  metadata: jsonRecord.optional()
}).transform(value => ({
  ...value,
  name: value.name || value.title
}));

export const messageSchema = z.object({
  receiverId: objectIdLike.optional(),
  conversationId: objectIdLike.optional(),
  content: z.string().trim().max(5000).optional(),
  mediaUrl: urlSchema.optional(),
  mediaType: z.enum(["IMAGE", "VIDEO", "AUDIO", "FILE", "GIF", "NONE"]).optional(),
  replyToId: optionalObjectIdLike,
  clientId: z.string().trim().max(128).optional(),
  mentions: z.array(objectIdLike).max(100).optional(),
  hashtags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  linkPreviews: z.array(jsonRecord).max(10).optional(),
  poll: jsonRecord.optional(),
  payment: jsonRecord.optional(),
  metadata: jsonRecord.optional()
}).refine(value => value.receiverId || value.conversationId, "Receiver or conversation required").refine(value => Boolean(value.content || value.mediaUrl || value.poll || value.payment), "Message content or media required");

export const messageEditSchema = z.object({
  messageId: objectIdLike,
  content: safeText(1, 5000)
});

export const messageDeleteSchema = z.object({
  messageId: objectIdLike,
  forEveryone: z.boolean().optional().default(false)
});

export const messageReactionSchema = z.object({
  messageId: objectIdLike,
  emoji: z.string().trim().min(1).max(32),
  remove: z.boolean().optional().default(false)
});

export const roomSchema = z.object({
  roomId: objectIdLike
});

export const createRoomSchema = z.object({
  title: safeText(2, 80),
  description: z.string().trim().max(500).optional(),
  topic: z.string().trim().max(80).optional(),
  coverUrl: nullableUrlSchema.optional(),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional().default("PUBLIC"),
  maxSeats: intish().min(1).max(10).optional().default(10),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional().default([]),
  language: z.string().trim().min(2).max(20).optional(),
  category: z.string().trim().max(80).optional(),
  isRecordingEnabled: z.boolean().optional().default(false),
  allowGifts: z.boolean().optional().default(true),
  allowChat: z.boolean().optional().default(true),
  settings: jsonRecord.optional()
});

export const updateRoomSchema = z.object({
  roomId: objectIdLike,
  title: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  topic: z.string().trim().max(80).optional(),
  coverUrl: nullableUrlSchema.optional(),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional(),
  maxSeats: intish().min(1).max(10).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  category: z.string().trim().max(80).optional(),
  allowGifts: z.boolean().optional(),
  allowChat: z.boolean().optional(),
  settings: jsonRecord.optional()
});

export const seatSchema = z.object({
  roomId: objectIdLike.optional(),
  seatIndex: intish().min(0).max(9).optional()
});

export const chatSchema = z.object({
  content: z.string().trim().max(500).optional(),
  mediaUrl: urlSchema.optional(),
  mediaType: z.enum(["IMAGE", "VIDEO", "AUDIO", "FILE", "GIF", "NONE"]).optional(),
  replyToId: optionalObjectIdLike,
  clientId: z.string().trim().max(128).optional()
}).refine(value => Boolean(value.content || value.mediaUrl), "Message required");

export const giftSchema = z.object({
  toId: objectIdLike,
  giftId: z.string().trim().min(1).max(80),
  amount: numberish().min(1).max(100000)
});

export const hostActionSchema = z.object({
  action: z.enum([
    "mute",
    "unmute",
    "kick",
    "promote_mod",
    "remove_mod",
    "lock_room",
    "unlock_room",
    "close_room",
    "transfer_host",
    "raise_hand",
    "lower_hand",
    "launch_poll",
    "pause_music",
    "resume_music",
    "next_music"
  ]),
  targetId: objectIdLike.optional(),
  question: z.string().trim().max(160).optional(),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(6).optional()
});

export const roomActionSchema = z.object({
  roomId: objectIdLike,
  action: z.enum([
    "mute",
    "unmute",
    "kick",
    "promote",
    "promote_mod",
    "remove_mod",
    "close",
    "close_room",
    "lock_room",
    "unlock_room",
    "pause_music",
    "resume_music",
    "next_music",
    "transfer_host",
    "lower_hand"
  ]),
  targetId: objectIdLike.optional()
});

export const pollVoteSchema = z.object({
  pollId: z.string().trim().min(1).max(120),
  optionIndex: intish().min(0).max(20)
});

export const tradeActionSchema = z.object({
  choiceId: z.string().trim().min(1).max(120),
  amount: numberish().min(10).max(5000).optional()
});

export const createTradingDaySchema = z.object({
  date: z.string().trim().min(4).max(40),
  title: safeText(2, 120),
  description: z.string().trim().max(500).optional(),
  choices: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(120),
    iconKey: z.string().trim().max(80).optional(),
    color: z.string().trim().regex(hexColorRegex).optional(),
    gradient: z.array(z.string().trim().regex(hexColorRegex)).min(1).max(4).optional(),
    category: z.string().trim().max(80).optional()
  })).min(2).max(8),
  lockedAt: z.string().datetime().optional()
});

export const resolveTradingDaySchema = z.object({
  dayId: objectIdLike,
  winnerChoice: z.string().trim().min(1).max(120)
});

export const postCreateSchema = z.object({
  content: z.string().trim().max(5000).optional(),
  mediaUrls: z.array(urlSchema).max(10).optional().default([]),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional().default("PUBLIC"),
  location: z.string().trim().max(120).optional(),
  hashtags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  mentions: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  metadata: jsonRecord.optional()
}).refine(value => Boolean(value.content || value.mediaUrls.length), "Post content or media required");

export const postUpdateSchema = z.object({
  postId: objectIdLike,
  content: z.string().trim().max(5000).optional(),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional(),
  location: z.string().trim().max(120).optional(),
  metadata: jsonRecord.optional()
});

export const commentCreateSchema = z.object({
  targetId: objectIdLike,
  targetType: z.enum(["POST", "REEL", "STORY", "PRODUCT"]),
  content: safeText(1, 1000),
  parentId: optionalObjectIdLike
});

export const reelCreateSchema = z.object({
  caption: z.string().trim().max(2200).optional(),
  videoUrl: urlSchema,
  thumbnailUrl: urlSchema.optional(),
  audioUrl: urlSchema.optional(),
  duration: numberish().min(0.1).max(600).optional(),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional().default("PUBLIC"),
  allowDuet: z.boolean().optional().default(true),
  allowComments: z.boolean().optional().default(true),
  hashtags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  mentions: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  category: z.string().trim().max(80).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  metadata: jsonRecord.optional()
});

export const storyCreateSchema = z.object({
  mediaUrl: urlSchema,
  mediaType: z.enum(["IMAGE", "VIDEO"]),
  caption: z.string().trim().max(500).optional(),
  duration: numberish().min(1).max(60).optional(),
  visibility: z.enum(["PUBLIC", "FOLLOWERS", "PRIVATE"]).optional().default("PUBLIC"),
  metadata: jsonRecord.optional()
});

export const productCreateSchema = z.object({
  storeId: objectIdLike.optional(),
  name: safeText(2, 160).optional(),
  title: safeText(2, 160).optional(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,120}$/).optional(),
  description: z.string().trim().max(5000).optional(),
  price: numberish().min(0).max(100000000),
  compareAtPrice: numberish().min(0).max(100000000).optional(),
  currency: z.string().trim().min(3).max(3).optional().default("INR"),
  images: z.array(urlSchema).max(12).optional(),
  mediaUrls: z.array(urlSchema).max(12).optional(),
  primaryMediaUrl: urlSchema.optional(),
  videoUrl: urlSchema.optional(),
  category: z.string().trim().min(1).max(120).optional(),
  categoryIds: z.array(objectIdLike).max(20).optional(),
  subCategory: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  stock: intish().min(0).max(1000000).optional(),
  inventory: intish().min(0).max(1000000).optional(),
  lowStockThreshold: intish().min(0).max(1000000).optional(),
  sku: z.string().trim().max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  attributes: jsonRecord.optional(),
  isDigital: z.boolean().optional(),
  shippingWeight: numberish().min(0).max(1000000).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED", "OUT_OF_STOCK"]).optional().default("DRAFT"),
  metadata: jsonRecord.optional()
}).transform(value => {
  const mediaUrls = value.mediaUrls || value.images || [];
  return {
    ...value,
    name: value.name || value.title || "",
    mediaUrls,
    primaryMediaUrl: value.primaryMediaUrl || mediaUrls[0] || value.videoUrl,
    inventory: value.inventory ?? value.stock ?? 0,
    categoryIds: value.categoryIds || []
  };
}).refine(value => value.name.length >= 2, "Product name is required");

export const productUpdateSchema = productCreateSchema.partial().extend({
  productId: objectIdLike
});

export const orderCreateSchema = z.object({
  storeId: objectIdLike.optional(),
  items: z.array(z.object({
    productId: objectIdLike,
    quantity: intish().min(1).max(100),
    attributes: jsonRecord.optional()
  })).min(1).max(50),
  addressId: objectIdLike.optional(),
  shippingAddress: jsonRecord.optional(),
  billingAddress: jsonRecord.optional(),
  paymentMethod: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional()
});

export const reportSchema = z.object({
  targetId: objectIdLike,
  targetType: z.enum(["USER", "POST", "REEL", "STORY", "COMMENT", "MESSAGE", "ROOM", "PRODUCT", "STORE"]),
  reason: z.string().trim().min(2).max(120),
  details: z.string().trim().max(1000).optional(),
  description: z.string().trim().max(1000).optional(),
  evidenceUrls: z.array(urlSchema).max(10).optional().default([])
}).transform(value => ({
  ...value,
  details: value.details || value.description
}));

export const moderationActionSchema = z.object({
  targetId: objectIdLike,
  targetType: z.enum(["USER", "POST", "REEL", "STORY", "COMMENT", "MESSAGE", "ROOM", "PRODUCT", "STORE", "REPORT"]),
  action: z.enum(["APPROVE", "REJECT", "WARN", "HIDE", "UNHIDE", "DELETE", "RESTORE", "SUSPEND", "UNSUSPEND", "BAN", "UNBAN"]),
  reason: z.string().trim().max(500).optional(),
  durationHours: intish().min(1).max(87600).optional()
});

export const notificationCreateSchema = z.object({
  userId: objectIdLike,
  type: z.enum(["LIKE", "COMMENT", "FOLLOW", "MESSAGE", "GIFT", "ORDER", "ROOM", "SYSTEM", "SECURITY"]),
  title: safeText(1, 120),
  body: z.string().trim().max(500).optional(),
  imageUrl: nullableUrlSchema.optional(),
  actionUrl: z.string().trim().max(2048).optional(),
  data: jsonRecord.optional(),
  metadata: jsonRecord.optional()
}).transform(value => ({
  ...value,
  data: value.data || value.metadata || {}
}));

export const uploadSchema = z.object({
  folder: z.string().trim().min(1).max(120).optional(),
  type: z.enum(["image", "video", "audio", "file", "auto"]).optional().default("auto")
});

export const signedUploadSchema = z.object({
  folder: z.string().trim().min(1).max(120).optional(),
  contentType: z.string().trim().min(3).max(120),
  fileName: z.string().trim().min(1).max(255).optional(),
  maxSizeBytes: intish().min(1).max(1024 * 1024 * 1024).optional()
});

export const walletTransactionSchema = z.object({
  userId: objectIdLike.optional(),
  amount: numberish().min(1).max(10000000),
  type: z.enum(["CREDIT", "DEBIT", "HOLD", "RELEASE", "REFUND", "BONUS"]),
  source: z.enum(["SYSTEM", "GIFT", "ROOM", "TRADE", "ORDER", "BONUS", "REFUND", "ADMIN"]).optional(),
  note: z.string().trim().max(500).optional(),
  metadata: jsonRecord.optional()
});

export const addressSchema = z.object({
  fullName: safeText(2, 80),
  phone: z.string().trim().regex(phoneRegex),
  line1: safeText(3, 160),
  line2: z.string().trim().max(160).optional(),
  city: safeText(2, 80),
  state: safeText(2, 80),
  country: safeText(2, 80).default("India"),
  postalCode: z.string().trim().min(3).max(20),
  landmark: z.string().trim().max(120).optional(),
  isDefault: z.boolean().optional().default(false)
});

export const storeCreateSchema = z.object({
  name: safeText(2, 120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,80}$/),
  description: z.string().trim().max(1000).optional(),
  logoUrl: nullableUrlSchema.optional(),
  bannerUrl: nullableUrlSchema.optional(),
  coverUrl: nullableUrlSchema.optional(),
  category: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().regex(phoneRegex).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  website: nullableUrlSchema.optional(),
  address: jsonRecord.optional(),
  contact: jsonRecord.optional(),
  socialLinks: jsonRecord.optional(),
  theme: jsonRecord.optional(),
  settings: jsonRecord.optional(),
  metadata: jsonRecord.optional()
});

export const storeUpdateSchema = storeCreateSchema.partial().extend({
  storeId: objectIdLike
});

export const adCreateSchema = z.object({
  storeId: objectIdLike.optional(),
  title: safeText(2, 120),
  body: z.string().trim().max(500).optional(),
  description: z.string().trim().max(500).optional(),
  mediaUrl: urlSchema.optional(),
  targetUrl: urlSchema.optional(),
  link: urlSchema.optional(),
  type: z.string().trim().min(1).max(80).optional().default("store_boost"),
  targetAudience: jsonRecord.optional(),
  budget: numberish().min(1).max(10000000),
  dailyLimit: numberish().min(1).max(10000000).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  metadata: jsonRecord.optional()
}).transform(value => ({
  ...value,
  description: value.description || value.body,
  link: value.link || value.targetUrl,
  dailyLimit: value.dailyLimit || value.budget,
  startDate: value.startDate || value.startsAt,
  endDate: value.endDate || value.endsAt,
  targetAudience: value.targetAudience || value.metadata || {}
}));

export const parseQueryBoolean = boolish;
export const parseQueryNumber = numberish();
export const parseQueryInteger = intish();

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MessageInput = z.infer<typeof messageSchema>;
export type TradeActionInput = z.infer<typeof tradeActionSchema>;
export type RoomActionInput = z.infer<typeof roomActionSchema>;
export type HostActionInput = z.infer<typeof hostActionSchema>;
export type ChatInput = z.infer<typeof chatSchema>;
export type GiftInput = z.infer<typeof giftSchema>;
