import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  Pressable,
  FlatList,
  Platform,
  Dimensions,
  AccessibilityRole
} from 'react-native';
import Svg, {
  Path,
  Circle,
  Rect,
  G,
  Defs,
  LinearGradient,
  Stop,
  Polygon
} from 'react-native-svg';
import { theme } from '../../theme';

const { width } = Dimensions.get('window');

type EmitFn = (event: string, data?: any, ack?: (response?: any) => void, priority?: number) => boolean | void;

type HostControlsProps = {
  emit: EmitFn;
  roomId?: string | null;
  locked?: boolean;
  mutedAll?: boolean;
  compact?: boolean;
  onCreatePoll?: () => void;
  onTransferHost?: () => void;
  onKickUser?: () => void;
  onInviteUser?: () => void;
  onOpenSettings?: () => void;
};

type HostAction = {
  id:
    | 'lock'
    | 'unlock'
    | 'mute_all'
    | 'unmute_all'
    | 'kick'
    | 'transfer'
    | 'poll'
    | 'invite'
    | 'music'
    | 'notice'
    | 'analytics'
    | 'close_room';
  label: string;
  subtitle: string;
  danger?: boolean;
  premium?: boolean;
  event: string;
  payload?: Record<string, any>;
  icon: React.ComponentType<{ size?: number; color?: string }>;
};

const colors = {
  gold: theme.colors?.premiumGold || theme.colors?.gold || '#D4A857',
  violet: theme.colors?.electricViolet || '#7C3CFF',
  cyan: theme.colors?.neonCyan || theme.colors?.neon || '#00E0FF',
  ink: '#121212',
  soft: '#747474',
  line: 'rgba(0,0,0,0.08)',
  danger: '#FF3B5F',
  bg: '#FFFFFF',
  panel: '#F8F9FC'
};

function LockIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="lockGrad" x1="8" y1="8" x2="56" y2="58">
          <Stop offset="0" stopColor={colors.gold} />
          <Stop offset="1" stopColor={colors.violet} />
        </LinearGradient>
      </Defs>
      <Rect x="13" y="27" width="38" height="28" rx="10" fill="url(#lockGrad)" />
      <Path d="M22 28V21C22 12.7 26.9 8 32 8C37.1 8 42 12.7 42 21V28" stroke={color} strokeWidth="5" strokeLinecap="round" />
      <Circle cx="32" cy="40" r="4" fill="#fff" />
      <Path d="M32 43V48" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </Svg>
  );
}

function UnlockIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="unlockGrad" x1="8" y1="8" x2="56" y2="58">
          <Stop offset="0" stopColor={colors.cyan} />
          <Stop offset="1" stopColor={colors.gold} />
        </LinearGradient>
      </Defs>
      <Rect x="13" y="28" width="38" height="27" rx="10" fill="url(#unlockGrad)" />
      <Path d="M22 29V20C22 12.8 26.7 8 33 8C38.8 8 43 12.1 43 17" stroke={color} strokeWidth="5" strokeLinecap="round" />
      <Circle cx="32" cy="41" r="4" fill="#fff" />
      <Path d="M32 44V49" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </Svg>
  );
}

function MuteAllIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="muteGrad" x1="7" y1="10" x2="58" y2="54">
          <Stop offset="0" stopColor={colors.danger} />
          <Stop offset="1" stopColor={colors.violet} />
        </LinearGradient>
      </Defs>
      <Path d="M14 25H25L39 13V51L25 39H14V25Z" fill="url(#muteGrad)" />
      <Path d="M48 24L57 33M57 24L48 33" stroke={color} strokeWidth="5" strokeLinecap="round" />
      <Path d="M8 56L56 8" stroke={color} strokeWidth="4" strokeLinecap="round" opacity="0.55" />
    </Svg>
  );
}

function UnmuteAllIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="unmuteGrad" x1="7" y1="10" x2="58" y2="54">
          <Stop offset="0" stopColor={colors.cyan} />
          <Stop offset="1" stopColor={colors.gold} />
        </LinearGradient>
      </Defs>
      <Path d="M12 25H24L39 12V52L24 39H12V25Z" fill="url(#unmuteGrad)" />
      <Path d="M46 23C49 26 50.5 29 50.5 32C50.5 35 49 38 46 41" stroke={color} strokeWidth="4" strokeLinecap="round" />
      <Path d="M52 17C57 22 59.5 27 59.5 32C59.5 37 57 42 52 47" stroke={color} strokeWidth="4" strokeLinecap="round" opacity="0.75" />
    </Svg>
  );
}

function KickIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="kickGrad" x1="8" y1="8" x2="58" y2="58">
          <Stop offset="0" stopColor="#FFB86B" />
          <Stop offset="1" stopColor={colors.danger} />
        </LinearGradient>
      </Defs>
      <Path d="M16 12H35C39 12 42 15 42 19V31H27C21 31 16 26 16 20V12Z" fill="url(#kickGrad)" />
      <Path d="M28 31H49C53 31 56 34 56 38V43H33C26 43 20 37 20 30" fill="url(#kickGrad)" opacity="0.9" />
      <Path d="M12 52H56" stroke={color} strokeWidth="5" strokeLinecap="round" />
      <Path d="M20 20H42" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.85" />
    </Svg>
  );
}

function CrownIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="crownGrad" x1="8" y1="12" x2="56" y2="54">
          <Stop offset="0" stopColor="#FFE7A3" />
          <Stop offset="0.55" stopColor={colors.gold} />
          <Stop offset="1" stopColor="#9C6B1E" />
        </LinearGradient>
      </Defs>
      <Path d="M10 22L22 34L32 14L42 34L54 22L49 50H15L10 22Z" fill="url(#crownGrad)" />
      <Circle cx="32" cy="14" r="4" fill="#fff" />
      <Circle cx="10" cy="22" r="3" fill="#fff" />
      <Circle cx="54" cy="22" r="3" fill="#fff" />
      <Path d="M17 50H47" stroke={color} strokeWidth="4" strokeLinecap="round" />
    </Svg>
  );
}

function PollIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="pollGrad" x1="9" y1="8" x2="55" y2="56">
          <Stop offset="0" stopColor={colors.cyan} />
          <Stop offset="1" stopColor={colors.violet} />
        </LinearGradient>
      </Defs>
      <Rect x="10" y="10" width="44" height="44" rx="14" fill="url(#pollGrad)" />
      <Rect x="20" y="34" width="6" height="10" rx="3" fill="#fff" />
      <Rect x="30" y="25" width="6" height="19" rx="3" fill="#fff" />
      <Rect x="40" y="18" width="6" height="26" rx="3" fill="#fff" />
      <Path d="M19 48H47" stroke={color} strokeWidth="3" strokeLinecap="round" opacity="0.55" />
    </Svg>
  );
}

function InviteIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="inviteGrad" x1="8" y1="8" x2="58" y2="56">
          <Stop offset="0" stopColor={colors.cyan} />
          <Stop offset="1" stopColor={colors.gold} />
        </LinearGradient>
      </Defs>
      <Circle cx="26" cy="23" r="12" fill="url(#inviteGrad)" />
      <Path d="M8 53C10.5 42 17.5 36 26 36C34.5 36 41.5 42 44 53" fill="url(#inviteGrad)" opacity="0.9" />
      <Circle cx="47" cy="25" r="10" fill="#fff" stroke={color} strokeWidth="4" />
      <Path d="M47 19V31M41 25H53" stroke={colors.violet} strokeWidth="4" strokeLinecap="round" />
    </Svg>
  );
}

function MusicIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="musicGrad" x1="9" y1="8" x2="56" y2="56">
          <Stop offset="0" stopColor="#FF77D9" />
          <Stop offset="1" stopColor={colors.violet} />
        </LinearGradient>
      </Defs>
      <Path d="M25 15L50 10V42" stroke="url(#musicGrad)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="20" cy="45" r="10" fill="url(#musicGrad)" />
      <Circle cx="45" cy="40" r="10" fill="url(#musicGrad)" />
      <Path d="M25 15V45" stroke={color} strokeWidth="3" strokeLinecap="round" opacity="0.55" />
    </Svg>
  );
}

function NoticeIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="noticeGrad" x1="8" y1="8" x2="56" y2="56">
          <Stop offset="0" stopColor="#FFF06B" />
          <Stop offset="1" stopColor={colors.gold} />
        </LinearGradient>
      </Defs>
      <Path d="M14 27C14 19 20 13 28 13H38C45 13 50 18 50 25V39C50 46 45 51 38 51H27L15 57V49C11 46 9 42 9 37V32C9 29 11 27 14 27Z" fill="url(#noticeGrad)" />
      <Path d="M23 28H42M23 37H36" stroke={color} strokeWidth="4" strokeLinecap="round" />
    </Svg>
  );
}

function AnalyticsIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="analyticsGrad" x1="8" y1="8" x2="56" y2="56">
          <Stop offset="0" stopColor={colors.cyan} />
          <Stop offset="1" stopColor={colors.gold} />
        </LinearGradient>
      </Defs>
      <Circle cx="32" cy="32" r="24" fill="url(#analyticsGrad)" />
      <Path d="M20 40L29 31L36 36L46 23" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="20" cy="40" r="3" fill={color} />
      <Circle cx="29" cy="31" r="3" fill={color} />
      <Circle cx="36" cy="36" r="3" fill={color} />
      <Circle cx="46" cy="23" r="3" fill={color} />
    </Svg>
  );
}

function CloseRoomIcon({ size = 22, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="closeRoomGrad" x1="8" y1="8" x2="56" y2="56">
          <Stop offset="0" stopColor="#FF8A8A" />
          <Stop offset="1" stopColor={colors.danger} />
        </LinearGradient>
      </Defs>
      <Polygon points="32,8 58,54 6,54" fill="url(#closeRoomGrad)" />
      <Path d="M32 24V38" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <Circle cx="32" cy="46" r="3" fill="#fff" />
      <Path d="M13 54H51" stroke={color} strokeWidth="4" strokeLinecap="round" opacity="0.45" />
    </Svg>
  );
}

function HostGearIcon({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="gearGrad" x1="8" y1="8" x2="56" y2="56">
          <Stop offset="0" stopColor="#FFFFFF" />
          <Stop offset="1" stopColor={colors.gold} />
        </LinearGradient>
      </Defs>
      <Path d="M32 7L38 12L46 10L50 18L58 22L55 31L58 40L50 44L46 52L38 50L32 57L26 50L18 52L14 44L6 40L9 31L6 22L14 18L18 10L26 12L32 7Z" fill="url(#gearGrad)" />
      <Circle cx="32" cy="32" r="10" fill={colors.violet} />
      <Circle cx="32" cy="32" r="4" fill={color} />
    </Svg>
  );
}

function ChevronIcon({ size = 18, color = colors.soft }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Path d="M25 16L41 32L25 48" stroke={color} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ShieldIcon({ size = 18, color = colors.gold }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Path d="M32 6L54 15V30C54 44 45 54 32 59C19 54 10 44 10 30V15L32 6Z" fill={color} />
      <Path d="M22 32L29 39L43 24" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const ActionIconWrap = memo(function ActionIconWrap({
  Icon,
  danger,
  premium
}: {
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  danger?: boolean;
  premium?: boolean;
}) {
  return (
    <View style={[styles.iconWrap, danger && styles.iconWrapDanger, premium && styles.iconWrapPremium]}>
      <Icon size={25} color={danger ? colors.danger : colors.ink} />
    </View>
  );
});

function HostControls({
  emit,
  roomId = null,
  locked = false,
  mutedAll = false,
  compact = false,
  onCreatePoll,
  onTransferHost,
  onKickUser,
  onInviteUser,
  onOpenSettings
}: HostControlsProps) {
  const [visible, setVisible] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const actions = useMemo<HostAction[]>(
    () => [
      locked
        ? {
            id: 'unlock',
            label: 'Unlock Room',
            subtitle: 'Allow users to take empty seats',
            event: 'host:control',
            payload: { control: 'locked', value: false },
            icon: UnlockIcon,
            premium: true
          }
        : {
            id: 'lock',
            label: 'Lock Room',
            subtitle: 'Stop new users from taking seats',
            event: 'host:control',
            payload: { control: 'locked', value: true },
            icon: LockIcon,
            premium: true
          },
      mutedAll
        ? {
            id: 'unmute_all',
            label: 'Unmute All',
            subtitle: 'Restore room microphone permissions',
            event: 'host:control',
            payload: { control: 'mutedAll', value: false },
            icon: UnmuteAllIcon
          }
        : {
            id: 'mute_all',
            label: 'Mute All',
            subtitle: 'Silence every active speaker instantly',
            event: 'host:control',
            payload: { control: 'mutedAll', value: true },
            icon: MuteAllIcon
          },
      {
        id: 'poll',
        label: 'Launch Poll',
        subtitle: 'Create live voting inside the room',
        event: 'poll:open_creator',
        icon: PollIcon,
        premium: true
      },
      {
        id: 'invite',
        label: 'Invite User',
        subtitle: 'Bring selected people into this room',
        event: 'room:invite_open',
        icon: InviteIcon
      },
      {
        id: 'kick',
        label: 'Kick User',
        subtitle: 'Remove a disruptive user safely',
        event: 'moderation:kick_open',
        icon: KickIcon,
        danger: true
      },
      {
        id: 'transfer',
        label: 'Transfer Host',
        subtitle: 'Give host power to another trusted user',
        event: 'host:transfer_open',
        icon: CrownIcon,
        premium: true
      },
      {
        id: 'music',
        label: 'Room Music',
        subtitle: 'Control background music and ambience',
        event: 'host:music_open',
        icon: MusicIcon
      },
      {
        id: 'notice',
        label: 'Pin Notice',
        subtitle: 'Broadcast an official host message',
        event: 'host:notice_open',
        icon: NoticeIcon
      },
      {
        id: 'analytics',
        label: 'Live Analytics',
        subtitle: 'View seats, chat, gifts and engagement',
        event: 'analytics:room_request',
        payload: { roomId },
        icon: AnalyticsIcon,
        premium: true
      },
      {
        id: 'close_room',
        label: 'Close Room',
        subtitle: 'End this room for everyone',
        event: 'room:close_request',
        payload: { roomId },
        icon: CloseRoomIcon,
        danger: true
      }
    ],
    [locked, mutedAll, roomId]
  );

  const close = useCallback(() => {
    setVisible(false);
    setBusyAction(null);
  }, []);

  const runAction = useCallback(
    (action: HostAction) => {
      if (busyAction) return;
      setBusyAction(action.id);

      if (action.id === 'poll' && onCreatePoll) {
        close();
        onCreatePoll();
        return;
      }

      if (action.id === 'transfer' && onTransferHost) {
        close();
        onTransferHost();
        return;
      }

      if (action.id === 'kick' && onKickUser) {
        close();
        onKickUser();
        return;
      }

      if (action.id === 'invite' && onInviteUser) {
        close();
        onInviteUser();
        return;
      }

      if (action.id === 'music' && onOpenSettings) {
        close();
        onOpenSettings();
        return;
      }

      const payload = {
        roomId,
        action: action.id,
        ...(action.payload || {})
      };

      const result = emit(action.event, payload, () => {
        setBusyAction(null);
      }, action.danger ? 9 : action.premium ? 7 : 5);

      if (result === false) {
        setBusyAction(null);
      } else {
        close();
      }
    },
    [busyAction, close, emit, onCreatePoll, onInviteUser, onKickUser, onOpenSettings, onTransferHost, roomId]
  );

  const renderAction = useCallback(
    ({ item }: { item: HostAction }) => (
      <TouchableOpacity
        activeOpacity={0.78}
        style={[styles.action, item.danger && styles.actionDanger, item.premium && styles.actionPremium]}
        onPress={() => runAction(item)}
        disabled={!!busyAction}
        accessibilityRole={'button' as AccessibilityRole}
        accessibilityLabel={`${item.label}. ${item.subtitle}`}
      >
        <ActionIconWrap Icon={item.icon} danger={item.danger} premium={item.premium} />
        <View style={styles.actionTextBox}>
          <View style={styles.actionTitleRow}>
            <Text style={[styles.actionLabel, item.danger && styles.actionLabelDanger]} numberOfLines={1}>
              {item.label}
            </Text>
            {item.premium && (
              <View style={styles.proPill}>
                <ShieldIcon size={12} color={colors.gold} />
                <Text style={styles.proText}>PRO</Text>
              </View>
            )}
          </View>
          <Text style={styles.actionSubtitle} numberOfLines={1}>
            {item.subtitle}
          </Text>
        </View>
        <ChevronIcon />
      </TouchableOpacity>
    ),
    [busyAction, runAction]
  );

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.82}
        style={[styles.hostBtn, compact && styles.hostBtnCompact]}
        onPress={() => setVisible(true)}
        accessibilityRole={'button' as AccessibilityRole}
        accessibilityLabel="Open host controls"
      >
        <HostGearIcon size={compact ? 16 : 18} />
        {!compact && <Text style={styles.hostText}>HOST</Text>}
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={close} />
          <View style={styles.sheet}>
            <View style={styles.handle} />

            <View style={styles.header}>
              <View>
                <Text style={styles.modalTitle}>Host Controls</Text>
                <Text style={styles.modalSub}>Manage room power, safety and live engagement</Text>
              </View>
              <View style={styles.hostMark}>
                <CrownIcon size={22} />
              </View>
            </View>

            <View style={styles.statusRow}>
              <View style={styles.statusPill}>
                <Text style={styles.statusKey}>Room</Text>
                <Text style={[styles.statusVal, locked && styles.statusValDanger]}>{locked ? 'Locked' : 'Open'}</Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusKey}>Mic</Text>
                <Text style={[styles.statusVal, mutedAll && styles.statusValDanger]}>{mutedAll ? 'Muted' : 'Live'}</Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusKey}>Mode</Text>
                <Text style={styles.statusVal}>Host</Text>
              </View>
            </View>

            <FlatList
              data={actions}
              keyExtractor={item => item.id}
              renderItem={renderAction}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.list}
              initialNumToRender={10}
              removeClippedSubviews={Platform.OS === 'android'}
            />

            <TouchableOpacity activeOpacity={0.82} style={styles.close} onPress={close} accessibilityRole={'button' as AccessibilityRole}>
              <Text style={styles.closeText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

export default memo(HostControls);

const styles = StyleSheet.create({
  hostBtn: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    marginLeft: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.violet,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    shadowColor: colors.violet,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5
  },
  hostBtnCompact: {
    width: 44,
    paddingHorizontal: 0
  },
  hostText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.7,
    marginLeft: 7
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end'
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.56)'
  },
  sheet: {
    width: '100%',
    maxHeight: '88%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: Platform.OS === 'ios' ? 30 : 18,
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -10 },
    elevation: 18
  },
  handle: {
    width: 48,
    height: 5,
    borderRadius: 99,
    backgroundColor: 'rgba(0,0,0,0.12)',
    alignSelf: 'center',
    marginBottom: 16
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.ink,
    letterSpacing: -0.3
  },
  modalSub: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '700',
    color: colors.soft,
    maxWidth: width * 0.72
  },
  hostMark: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(212,168,87,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.32)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  statusRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
    marginBottom: 12
  },
  statusPill: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 16,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line
  },
  statusKey: {
    fontSize: 10,
    fontWeight: '900',
    color: colors.soft,
    textTransform: 'uppercase',
    letterSpacing: 0.55
  },
  statusVal: {
    marginTop: 3,
    fontSize: 13,
    fontWeight: '900',
    color: colors.ink
  },
  statusValDanger: {
    color: colors.danger
  },
  list: {
    paddingTop: 2,
    paddingBottom: 10
  },
  action: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
    backgroundColor: colors.panel,
    borderRadius: 20,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.line
  },
  actionPremium: {
    backgroundColor: 'rgba(212,168,87,0.08)',
    borderColor: 'rgba(212,168,87,0.22)'
  },
  actionDanger: {
    backgroundColor: 'rgba(255,59,95,0.07)',
    borderColor: 'rgba(255,59,95,0.18)'
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    marginRight: 12
  },
  iconWrapPremium: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderColor: 'rgba(212,168,87,0.25)'
  },
  iconWrapDanger: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderColor: 'rgba(255,59,95,0.22)'
  },
  actionTextBox: {
    flex: 1,
    minWidth: 0
  },
  actionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  actionLabel: {
    fontWeight: '900',
    fontSize: 15,
    color: colors.ink,
    flexShrink: 1
  },
  actionLabelDanger: {
    color: colors.danger
  },
  actionSubtitle: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '700',
    color: colors.soft
  },
  proPill: {
    marginLeft: 7,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(212,168,87,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.28)'
  },
  proText: {
    marginLeft: 3,
    fontSize: 8,
    fontWeight: '900',
    color: colors.gold,
    letterSpacing: 0.45
  },
  close: {
    marginTop: 2,
    minHeight: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111'
  },
  closeText: {
    fontWeight: '900',
    color: '#FFFFFF',
    fontSize: 14,
    letterSpacing: 0.3
  }
});
