import { create } from 'zustand';
import { produce } from 'immer';

export type RoomUser = {
  id: string;
  username?: string;
  fullName?: string;
  displayName?: string;
  avatarUrl?: string;
  isVerified?: boolean;
  level?: string | number;
  xp?: number;
  role?: string;
};

export type RoomSeat = {
  id: string;
  userId: string;
  isHost: boolean;
  isCoHost?: boolean;
  isModerator?: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
  handRaised: boolean;
  joinedAt?: number;
  lastActiveAt?: number;
  audioLevel?: number;
  connectionQuality?: 'excellent' | 'good' | 'weak' | 'offline';
  user: RoomUser;
};

export type RoomChatMessage = {
  id: string;
  roomId?: string;
  senderId: string;
  content: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'file';
  replyToId?: string;
  replyTo?: Partial<RoomChatMessage>;
  reactions: Record<string, number>;
  reactedBy?: Record<string, string[]>;
  isPinned: boolean;
  isEdited?: boolean;
  isDeleted?: boolean;
  isSystem?: boolean;
  timestamp: number;
  sender: RoomUser;
};

export type RoomGift = {
  id?: string;
  from: string;
  to: string;
  giftId: string;
  amount: number;
  ts: number;
  sender?: RoomUser;
  receiver?: RoomUser;
};

export type RoomPollOption = {
  id: string;
  text: string;
  votes: number;
  voters?: string[];
};

export type RoomPoll = {
  id: string;
  question: string;
  options: RoomPollOption[];
  totalVotes: number;
  expiresAt?: string | number | null;
  createdBy?: string;
  isClosed?: boolean;
};

export type RoomMusic = {
  id?: string;
  title?: string;
  artist?: string;
  coverUrl?: string;
  url?: string;
  isPlaying?: boolean;
  position?: number;
  duration?: number;
};

export type RoomHostControls = {
  locked: boolean;
  music: RoomMusic | null;
  slowMode: boolean;
  slowModeSeconds: number;
  allowChat: boolean;
  allowGifts: boolean;
  allowRaiseHand: boolean;
  allowReactions: boolean;
  allowRecording: boolean;
  inviteOnly: boolean;
  maxSeats: number;
};

export type RoomConnection = {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
  socketId: string | null;
  latency: number;
  lastSyncedAt: number | null;
  error: string | null;
};

export type RoomUiState = {
  activePanel: 'none' | 'chat' | 'gifts' | 'poll' | 'members' | 'settings';
  composerFocused: boolean;
  selectedMessageId: string | null;
  selectedSeatId: string | null;
  unreadChatCount: number;
  unreadGiftCount: number;
  showMiniPlayer: boolean;
};

export type RoomState = {
  id: string | null;
  room: any;
  seats: RoomSeat[];
  chat: RoomChatMessage[];
  gifts: RoomGift[];
  poll: RoomPoll | null;
  hostControls: RoomHostControls;
  mySeatId: string | null;
  myUserId: string | null;
  isMuted: boolean;
  isPushToTalk: boolean;
  isHandRaised: boolean;
  isSpeaker: boolean;
  isHost: boolean;
  isCoHost: boolean;
  isModerator: boolean;
  speakingUsers: string[];
  blockedUsers: string[];
  typingUsers: Record<string, number>;
  connection: RoomConnection;
  ui: RoomUiState;
};

type RoomActions = {
  sync: (state: any) => void;
  hydrate: (state: Partial<RoomState>) => void;
  setRoom: (room: any) => void;
  setMyUser: (userId: string | null) => void;
  setMySeatId: (seatId: string | null) => void;
  setSeats: (seats: RoomSeat[]) => void;
  upsertSeat: (seat: RoomSeat) => void;
  removeSeat: (seatIdOrUserId: string) => void;
  updateSeat: (seatIdOrUserId: string, patch: Partial<RoomSeat>) => void;
  setSpeaking: (seatIdOrUserId: string, isSpeaking: boolean, audioLevel?: number) => void;
  setHandRaised: (seatIdOrUserId: string, handRaised: boolean) => void;
  setConnectionQuality: (seatIdOrUserId: string, quality: RoomSeat['connectionQuality']) => void;
  setChat: (messages: RoomChatMessage[]) => void;
  addChat: (msg: RoomChatMessage) => void;
  upsertChat: (msg: RoomChatMessage) => void;
  editChat: (msgId: string, content: string) => void;
  deleteChat: (msgId: string, soft?: boolean) => void;
  pinChat: (msgId: string, pinned?: boolean) => void;
  updateChatReaction: (msgId: string, reactions: Record<string, number>, reactedBy?: Record<string, string[]>) => void;
  addMessageReaction: (msgId: string, emoji: string, userId?: string) => void;
  removeMessageReaction: (msgId: string, emoji: string, userId?: string) => void;
  clearChat: () => void;
  addGift: (gift: Omit<RoomGift, 'ts'> & Partial<Pick<RoomGift, 'ts'>>) => void;
  clearGifts: () => void;
  setPoll: (poll: RoomPoll | null) => void;
  votePoll: (optionId: string, userId?: string) => void;
  closePoll: () => void;
  toggleMute: () => void;
  setMuted: (value: boolean) => void;
  togglePushToTalk: () => void;
  setPushToTalk: (value: boolean) => void;
  toggleMyHand: () => void;
  setMyHandRaised: (value: boolean) => void;
  setHostControl: <K extends keyof RoomHostControls>(control: K, value: RoomHostControls[K]) => void;
  patchHostControls: (patch: Partial<RoomHostControls>) => void;
  setTyping: (userId: string, isTyping: boolean) => void;
  sweepTyping: () => void;
  blockUser: (userId: string) => void;
  unblockUser: (userId: string) => void;
  setConnection: (patch: Partial<RoomConnection>) => void;
  setActivePanel: (panel: RoomUiState['activePanel']) => void;
  setComposerFocused: (value: boolean) => void;
  selectMessage: (messageId: string | null) => void;
  selectSeat: (seatId: string | null) => void;
  markChatRead: () => void;
  markGiftsRead: () => void;
  setMiniPlayer: (value: boolean) => void;
  clearRoom: () => void;
};

const MAX_CHAT_MESSAGES = 150;
const MAX_GIFTS = 80;
const TYPING_TTL = 5000;

const defaultHostControls: RoomHostControls = {
  locked: false,
  music: null,
  slowMode: false,
  slowModeSeconds: 3,
  allowChat: true,
  allowGifts: true,
  allowRaiseHand: true,
  allowReactions: true,
  allowRecording: false,
  inviteOnly: false,
  maxSeats: 12
};

const defaultConnection: RoomConnection = {
  status: 'idle',
  socketId: null,
  latency: 0,
  lastSyncedAt: null,
  error: null
};

const defaultUi: RoomUiState = {
  activePanel: 'none',
  composerFocused: false,
  selectedMessageId: null,
  selectedSeatId: null,
  unreadChatCount: 0,
  unreadGiftCount: 0,
  showMiniPlayer: false
};

const initialState: RoomState = {
  id: null,
  room: null,
  seats: [],
  chat: [],
  gifts: [],
  poll: null,
  hostControls: defaultHostControls,
  mySeatId: null,
  myUserId: null,
  isMuted: false,
  isPushToTalk: false,
  isHandRaised: false,
  isSpeaker: false,
  isHost: false,
  isCoHost: false,
  isModerator: false,
  speakingUsers: [],
  blockedUsers: [],
  typingUsers: {},
  connection: defaultConnection,
  ui: defaultUi
};

function normalizeTimestamp(value: any) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeChatMessage(msg: any): RoomChatMessage {
  return {
    id: String(msg.id || `local_${Date.now()}_${Math.random().toString(36).slice(2)}`),
    roomId: msg.roomId,
    senderId: String(msg.senderId || msg.userId || msg.sender?.id || ''),
    content: String(msg.content || ''),
    mediaUrl: msg.mediaUrl,
    mediaType: msg.mediaType,
    replyToId: msg.replyToId,
    replyTo: msg.replyTo,
    reactions: msg.reactions || {},
    reactedBy: msg.reactedBy || {},
    isPinned: !!msg.isPinned,
    isEdited: !!msg.isEdited,
    isDeleted: !!msg.isDeleted,
    isSystem: !!msg.isSystem,
    timestamp: normalizeTimestamp(msg.timestamp || msg.createdAt),
    sender: msg.sender || msg.user || {}
  };
}

function normalizeSeat(seat: any): RoomSeat {
  return {
    id: String(seat.id || seat.seatId || seat.userId),
    userId: String(seat.userId || seat.user?.id || ''),
    isHost: !!seat.isHost,
    isCoHost: !!seat.isCoHost,
    isModerator: !!seat.isModerator,
    isMuted: !!seat.isMuted,
    isSpeaking: !!seat.isSpeaking,
    handRaised: !!seat.handRaised,
    joinedAt: normalizeTimestamp(seat.joinedAt || Date.now()),
    lastActiveAt: normalizeTimestamp(seat.lastActiveAt || Date.now()),
    audioLevel: Number(seat.audioLevel || 0),
    connectionQuality: seat.connectionQuality || 'good',
    user: seat.user || {}
  };
}

function uniqueById<T extends { id?: string }>(items: T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!item.id) continue;
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

function deriveMe(draft: RoomState) {
  const mySeat = draft.seats.find(s => s.id === draft.mySeatId || s.userId === draft.myUserId) || null;
  draft.mySeatId = mySeat?.id || draft.mySeatId;
  draft.myUserId = mySeat?.userId || draft.myUserId;
  draft.isSpeaker = !!mySeat;
  draft.isHost = !!mySeat?.isHost;
  draft.isCoHost = !!mySeat?.isCoHost;
  draft.isModerator = !!mySeat?.isModerator;
  draft.isMuted = mySeat ? !!mySeat.isMuted : draft.isMuted;
  draft.isHandRaised = mySeat ? !!mySeat.handRaised : draft.isHandRaised;
  draft.speakingUsers = draft.seats.filter(s => s.isSpeaking).map(s => s.userId);
}

function trimCollections(draft: RoomState) {
  if (draft.chat.length > MAX_CHAT_MESSAGES) draft.chat = draft.chat.slice(-MAX_CHAT_MESSAGES);
  if (draft.gifts.length > MAX_GIFTS) draft.gifts = draft.gifts.slice(-MAX_GIFTS);
}

export const useRoomStore = create<RoomState & RoomActions>((set, get) => ({
  ...initialState,

  sync: state => set(produce((draft: RoomState) => {
    const room = state?.room || state || null;
    draft.id = room?.id || state?.id || null;
    draft.room = room;
    draft.seats = Array.isArray(state?.seats) ? state.seats.map(normalizeSeat) : draft.seats;
    draft.chat = Array.isArray(state?.recentChat) ? state.recentChat.map(normalizeChatMessage) : Array.isArray(state?.chat) ? state.chat.map(normalizeChatMessage) : draft.chat;
    draft.gifts = Array.isArray(state?.gifts) ? state.gifts.slice(-MAX_GIFTS) : draft.gifts;
    draft.poll = state?.poll ?? draft.poll;
    draft.hostControls = { ...defaultHostControls, ...draft.hostControls, ...(state?.hostControls || room?.hostControls || {}) };
    draft.connection.lastSyncedAt = Date.now();
    draft.connection.status = 'connected';
    draft.connection.error = null;
    trimCollections(draft);
    deriveMe(draft);
  })),

  hydrate: state => set(produce((draft: RoomState) => {
    Object.assign(draft, state);
    draft.hostControls = { ...defaultHostControls, ...(state.hostControls || draft.hostControls || {}) };
    draft.connection = { ...defaultConnection, ...(state.connection || draft.connection || {}) };
    draft.ui = { ...defaultUi, ...(state.ui || draft.ui || {}) };
    trimCollections(draft);
    deriveMe(draft);
  })),

  setRoom: room => set(produce((draft: RoomState) => {
    draft.room = room;
    draft.id = room?.id || null;
  })),

  setMyUser: userId => set(produce((draft: RoomState) => {
    draft.myUserId = userId;
    deriveMe(draft);
  })),

  setMySeatId: seatId => set(produce((draft: RoomState) => {
    draft.mySeatId = seatId;
    deriveMe(draft);
  })),

  setSeats: seats => set(produce((draft: RoomState) => {
    draft.seats = seats.map(normalizeSeat);
    deriveMe(draft);
  })),

  upsertSeat: seat => set(produce((draft: RoomState) => {
    const normalized = normalizeSeat(seat);
    const index = draft.seats.findIndex(s => s.id === normalized.id || s.userId === normalized.userId);
    if (index >= 0) draft.seats[index] = { ...draft.seats[index], ...normalized };
    else draft.seats.push(normalized);
    deriveMe(draft);
  })),

  removeSeat: seatIdOrUserId => set(produce((draft: RoomState) => {
    draft.seats = draft.seats.filter(s => s.id !== seatIdOrUserId && s.userId !== seatIdOrUserId);
    if (draft.mySeatId === seatIdOrUserId || draft.myUserId === seatIdOrUserId) {
      draft.mySeatId = null;
      draft.isSpeaker = false;
      draft.isHost = false;
      draft.isCoHost = false;
      draft.isModerator = false;
      draft.isHandRaised = false;
    }
    deriveMe(draft);
  })),

  updateSeat: (seatIdOrUserId, patch) => set(produce((draft: RoomState) => {
    const seat = draft.seats.find(s => s.id === seatIdOrUserId || s.userId === seatIdOrUserId);
    if (seat) Object.assign(seat, patch, { lastActiveAt: Date.now() });
    deriveMe(draft);
  })),

  setSpeaking: (seatIdOrUserId, isSpeaking, audioLevel = 0) => set(produce((draft: RoomState) => {
    const seat = draft.seats.find(s => s.id === seatIdOrUserId || s.userId === seatIdOrUserId);
    if (seat) {
      seat.isSpeaking = isSpeaking;
      seat.audioLevel = audioLevel;
      seat.lastActiveAt = Date.now();
    }
    deriveMe(draft);
  })),

  setHandRaised: (seatIdOrUserId, handRaised) => set(produce((draft: RoomState) => {
    const seat = draft.seats.find(s => s.id === seatIdOrUserId || s.userId === seatIdOrUserId);
    if (seat) seat.handRaised = handRaised;
    deriveMe(draft);
  })),

  setConnectionQuality: (seatIdOrUserId, quality) => set(produce((draft: RoomState) => {
    const seat = draft.seats.find(s => s.id === seatIdOrUserId || s.userId === seatIdOrUserId);
    if (seat) seat.connectionQuality = quality;
  })),

  setChat: messages => set(produce((draft: RoomState) => {
    draft.chat = uniqueById(messages.map(normalizeChatMessage)).sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_CHAT_MESSAGES);
  })),

  addChat: msg => set(produce((draft: RoomState) => {
    const normalized = normalizeChatMessage(msg);
    if (!draft.chat.some(m => m.id === normalized.id)) draft.chat.push(normalized);
    draft.chat.sort((a, b) => a.timestamp - b.timestamp);
    if (draft.ui.activePanel !== 'chat') draft.ui.unreadChatCount += 1;
    trimCollections(draft);
  })),

  upsertChat: msg => set(produce((draft: RoomState) => {
    const normalized = normalizeChatMessage(msg);
    const index = draft.chat.findIndex(m => m.id === normalized.id);
    if (index >= 0) draft.chat[index] = { ...draft.chat[index], ...normalized };
    else draft.chat.push(normalized);
    draft.chat.sort((a, b) => a.timestamp - b.timestamp);
    trimCollections(draft);
  })),

  editChat: (msgId, content) => set(produce((draft: RoomState) => {
    const msg = draft.chat.find(m => m.id === msgId);
    if (msg) {
      msg.content = content;
      msg.isEdited = true;
    }
  })),

  deleteChat: (msgId, soft = true) => set(produce((draft: RoomState) => {
    if (soft) {
      const msg = draft.chat.find(m => m.id === msgId);
      if (msg) {
        msg.content = '';
        msg.mediaUrl = undefined;
        msg.isDeleted = true;
      }
    } else {
      draft.chat = draft.chat.filter(m => m.id !== msgId);
    }
  })),

  pinChat: (msgId, pinned = true) => set(produce((draft: RoomState) => {
    const msg = draft.chat.find(m => m.id === msgId);
    if (msg) msg.isPinned = pinned;
  })),

  updateChatReaction: (msgId, reactions, reactedBy) => set(produce((draft: RoomState) => {
    const msg = draft.chat.find(m => m.id === msgId);
    if (msg) {
      msg.reactions = { ...msg.reactions, ...reactions };
      if (reactedBy) msg.reactedBy = { ...(msg.reactedBy || {}), ...reactedBy };
    }
  })),

  addMessageReaction: (msgId, emoji, userId) => set(produce((draft: RoomState) => {
    const msg = draft.chat.find(m => m.id === msgId);
    if (!msg) return;
    msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
    if (userId) {
      if (!msg.reactedBy) msg.reactedBy = {};
      if (!msg.reactedBy[emoji]) msg.reactedBy[emoji] = [];
      if (!msg.reactedBy[emoji].includes(userId)) msg.reactedBy[emoji].push(userId);
    }
  })),

  removeMessageReaction: (msgId, emoji, userId) => set(produce((draft: RoomState) => {
    const msg = draft.chat.find(m => m.id === msgId);
    if (!msg) return;
    msg.reactions[emoji] = Math.max(0, (msg.reactions[emoji] || 0) - 1);
    if (msg.reactions[emoji] === 0) delete msg.reactions[emoji];
    if (userId && msg.reactedBy?.[emoji]) {
      msg.reactedBy[emoji] = msg.reactedBy[emoji].filter(id => id !== userId);
      if (!msg.reactedBy[emoji].length) delete msg.reactedBy[emoji];
    }
  })),

  clearChat: () => set(produce((draft: RoomState) => {
    draft.chat = [];
    draft.ui.unreadChatCount = 0;
  })),

  addGift: gift => set(produce((draft: RoomState) => {
    draft.gifts.push({ ...gift, ts: gift.ts || Date.now() });
    if (draft.ui.activePanel !== 'gifts') draft.ui.unreadGiftCount += 1;
    trimCollections(draft);
  })),

  clearGifts: () => set(produce((draft: RoomState) => {
    draft.gifts = [];
    draft.ui.unreadGiftCount = 0;
  })),

  setPoll: poll => set(produce((draft: RoomState) => {
    draft.poll = poll;
  })),

  votePoll: (optionId, userId) => set(produce((draft: RoomState) => {
    if (!draft.poll || draft.poll.isClosed) return;
    const uid = userId || draft.myUserId || '';
    const alreadyVoted = draft.poll.options.some(option => option.voters?.includes(uid));
    if (uid && alreadyVoted) return;
    const option = draft.poll.options.find(o => o.id === optionId);
    if (!option) return;
    option.votes += 1;
    option.voters = Array.from(new Set([...(option.voters || []), uid].filter(Boolean)));
    draft.poll.totalVotes += 1;
  })),

  closePoll: () => set(produce((draft: RoomState) => {
    if (draft.poll) draft.poll.isClosed = true;
  })),

  toggleMute: () => set(produce((draft: RoomState) => {
    draft.isMuted = !draft.isMuted;
    const seat = draft.seats.find(s => s.id === draft.mySeatId || s.userId === draft.myUserId);
    if (seat) seat.isMuted = draft.isMuted;
  })),

  setMuted: value => set(produce((draft: RoomState) => {
    draft.isMuted = value;
    const seat = draft.seats.find(s => s.id === draft.mySeatId || s.userId === draft.myUserId);
    if (seat) seat.isMuted = value;
  })),

  togglePushToTalk: () => set(produce((draft: RoomState) => {
    draft.isPushToTalk = !draft.isPushToTalk;
  })),

  setPushToTalk: value => set(produce((draft: RoomState) => {
    draft.isPushToTalk = value;
  })),

  toggleMyHand: () => set(produce((draft: RoomState) => {
    draft.isHandRaised = !draft.isHandRaised;
    const seat = draft.seats.find(s => s.id === draft.mySeatId || s.userId === draft.myUserId);
    if (seat) seat.handRaised = draft.isHandRaised;
  })),

  setMyHandRaised: value => set(produce((draft: RoomState) => {
    draft.isHandRaised = value;
    const seat = draft.seats.find(s => s.id === draft.mySeatId || s.userId === draft.myUserId);
    if (seat) seat.handRaised = value;
  })),

  setHostControl: (control, value) => set(produce((draft: RoomState) => {
    draft.hostControls[control] = value;
  })),

  patchHostControls: patch => set(produce((draft: RoomState) => {
    draft.hostControls = { ...draft.hostControls, ...patch };
  })),

  setTyping: (userId, isTyping) => set(produce((draft: RoomState) => {
    if (!userId) return;
    if (isTyping) draft.typingUsers[userId] = Date.now();
    else delete draft.typingUsers[userId];
  })),

  sweepTyping: () => set(produce((draft: RoomState) => {
    const now = Date.now();
    Object.entries(draft.typingUsers).forEach(([userId, ts]) => {
      if (now - ts > TYPING_TTL) delete draft.typingUsers[userId];
    });
  })),

  blockUser: userId => set(produce((draft: RoomState) => {
    if (!draft.blockedUsers.includes(userId)) draft.blockedUsers.push(userId);
    draft.chat = draft.chat.filter(m => m.senderId !== userId);
  })),

  unblockUser: userId => set(produce((draft: RoomState) => {
    draft.blockedUsers = draft.blockedUsers.filter(id => id !== userId);
  })),

  setConnection: patch => set(produce((draft: RoomState) => {
    draft.connection = { ...draft.connection, ...patch };
  })),

  setActivePanel: panel => set(produce((draft: RoomState) => {
    draft.ui.activePanel = panel;
    if (panel === 'chat') draft.ui.unreadChatCount = 0;
    if (panel === 'gifts') draft.ui.unreadGiftCount = 0;
  })),

  setComposerFocused: value => set(produce((draft: RoomState) => {
    draft.ui.composerFocused = value;
  })),

  selectMessage: messageId => set(produce((draft: RoomState) => {
    draft.ui.selectedMessageId = messageId;
  })),

  selectSeat: seatId => set(produce((draft: RoomState) => {
    draft.ui.selectedSeatId = seatId;
  })),

  markChatRead: () => set(produce((draft: RoomState) => {
    draft.ui.unreadChatCount = 0;
  })),

  markGiftsRead: () => set(produce((draft: RoomState) => {
    draft.ui.unreadGiftCount = 0;
  })),

  setMiniPlayer: value => set(produce((draft: RoomState) => {
    draft.ui.showMiniPlayer = value;
  })),

  clearRoom: () => set({
    ...initialState,
    hostControls: { ...defaultHostControls },
    connection: { ...defaultConnection },
    ui: { ...defaultUi }
  })
}));

export const roomSelectors = {
  currentRoom: (state: RoomState) => state.room,
  roomId: (state: RoomState) => state.id,
  seats: (state: RoomState) => state.seats,
  speakers: (state: RoomState) => state.seats.filter(seat => seat.isSpeaking),
  raisedHands: (state: RoomState) => state.seats.filter(seat => seat.handRaised),
  hosts: (state: RoomState) => state.seats.filter(seat => seat.isHost || seat.isCoHost),
  mySeat: (state: RoomState) => state.seats.find(seat => seat.id === state.mySeatId || seat.userId === state.myUserId) || null,
  pinnedMessages: (state: RoomState) => state.chat.filter(msg => msg.isPinned && !msg.isDeleted),
  visibleChat: (state: RoomState) => state.chat.filter(msg => !state.blockedUsers.includes(msg.senderId)),
  latestGift: (state: RoomState) => state.gifts[state.gifts.length - 1] || null,
  typingUserIds: (state: RoomState) => Object.keys(state.typingUsers),
  canChat: (state: RoomState) => state.hostControls.allowChat && !state.hostControls.locked,
  canGift: (state: RoomState) => state.hostControls.allowGifts,
  canRaiseHand: (state: RoomState) => state.hostControls.allowRaiseHand && !state.isSpeaker,
  isConnected: (state: RoomState) => state.connection.status === 'connected'
};

export const roomIcons = {
  host: '♛',
  coHost: '◆',
  moderator: '✦',
  micOn: '◉',
  micOff: '◌',
  speaking: '◍',
  hand: '✋',
  lock: '▣',
  unlock: '▢',
  chat: '✉',
  gift: '✧',
  poll: '◈',
  music: '♪',
  members: '◎',
  settings: '⚙',
  shield: '⬟',
  crown: '♕',
  live: '●',
  signalExcellent: '▰▰▰▰',
  signalGood: '▰▰▰▱',
  signalWeak: '▰▰▱▱',
  signalOffline: '▱▱▱▱'
};
