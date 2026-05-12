import React, { memo, useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  I18nManager,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle
} from "react-native";

type MessageActionKey = "reply" | "react" | "forward" | "share" | "delete" | "deleteEveryone";

type MessageAction = {
  key: MessageActionKey;
  icon: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

interface Props {
  onReply: () => void;
  onReact: (emoji: string) => void;
  onForward: () => void;
  onShare: () => void;
  onDelete: (forEveryone: boolean) => void;
  isOwn: boolean;
  disabled?: boolean;
  compact?: boolean;
  style?: ViewStyle;
  defaultEmoji?: string;
  onClose?: () => void;
}

function MessageActions({
  onReply,
  onReact,
  onForward,
  onShare,
  onDelete,
  isOwn,
  disabled = false,
  compact = false,
  style,
  defaultEmoji = "❤️",
  onClose
}: Props) {
  const scale = useRef(new Animated.Value(0.96)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.spring(scale, {
        toValue: 1,
        tension: 180,
        friction: 16,
        useNativeDriver: true
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    ]).start();
  }, [opacity, scale, translateY]);

  const runAction = (handler: () => void) => {
    if (disabled) return;
    handler();
    onClose?.();
  };

  const actions = useMemo<MessageAction[]>(() => {
    const base: MessageAction[] = [
      {
        key: "reply",
        icon: "↩️",
        label: "Reply",
        onPress: () => runAction(onReply)
      },
      {
        key: "react",
        icon: defaultEmoji,
        label: "React",
        onPress: () => runAction(() => onReact(defaultEmoji))
      },
      {
        key: "forward",
        icon: "↗️",
        label: "Forward",
        onPress: () => runAction(onForward)
      },
      {
        key: "share",
        icon: "📤",
        label: "Share",
        onPress: () => runAction(onShare)
      },
      {
        key: "delete",
        icon: "🗑️",
        label: "Delete",
        destructive: true,
        onPress: () => runAction(() => onDelete(false))
      }
    ];

    if (isOwn) {
      base.push({
        key: "deleteEveryone",
        icon: "⛔",
        label: compact ? "All" : "Delete All",
        destructive: true,
        onPress: () => runAction(() => onDelete(true))
      });
    }

    return base;
  }, [compact, defaultEmoji, isOwn, onDelete, onForward, onReact, onReply, onShare]);

  return (
    <Animated.View
      style={[
        styles.container,
        compact && styles.compactContainer,
        disabled && styles.disabledContainer,
        {
          opacity,
          transform: [{ scale }, { translateY }]
        },
        style
      ]}
    >
      {actions.map((action, index) => (
        <Pressable
          key={action.key}
          disabled={disabled || action.disabled}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          android_ripple={{ color: "rgba(0,0,0,0.08)", borderless: false }}
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.item,
            compact && styles.compactItem,
            action.destructive && styles.dangerItem,
            pressed && styles.pressed,
            index === 0 && styles.firstItem,
            index === actions.length - 1 && styles.lastItem
          ]}
        >
          <View style={[styles.iconWrap, action.destructive && styles.dangerIconWrap]}>
            <Text style={styles.icon}>{action.icon}</Text>
          </View>
          <Text
            numberOfLines={1}
            style={[
              styles.label,
              compact && styles.compactLabel,
              action.destructive && styles.dangerLabel
            ]}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </Animated.View>
  );
}

export default memo(MessageActions);

const styles = StyleSheet.create({
  container: {
    flexDirection: I18nManager.isRTL ? "row-reverse" : "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 22,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(20,20,35,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 10,
    maxWidth: "96%"
  },
  compactContainer: {
    borderRadius: 18,
    paddingHorizontal: 6,
    paddingVertical: 6
  },
  disabledContainer: {
    opacity: 0.55
  },
  item: {
    minWidth: 54,
    minHeight: 58,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 7,
    marginHorizontal: 2,
    borderRadius: 16
  },
  compactItem: {
    minWidth: 46,
    minHeight: 50,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 14
  },
  firstItem: {
    marginLeft: 0
  },
  lastItem: {
    marginRight: 0
  },
  pressed: {
    transform: [{ scale: 0.94 }],
    backgroundColor: "rgba(0,245,212,0.09)"
  },
  dangerItem: {
    backgroundColor: "rgba(255,71,87,0.04)"
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,245,212,0.1)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,245,212,0.22)"
  },
  dangerIconWrap: {
    backgroundColor: "rgba(255,71,87,0.1)",
    borderColor: "rgba(255,71,87,0.22)"
  },
  icon: {
    fontSize: 18,
    textAlign: "center"
  },
  label: {
    marginTop: 4,
    fontSize: 10.5,
    lineHeight: 13,
    fontWeight: "700",
    color: "#1A1A2E",
    letterSpacing: 0.1,
    textAlign: "center"
  },
  compactLabel: {
    fontSize: 9.5,
    lineHeight: 12
  },
  dangerLabel: {
    color: "#FF4757"
  }
});
