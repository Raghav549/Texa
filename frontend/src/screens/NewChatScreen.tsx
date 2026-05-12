import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { api } from "../api/client";
import { useAuth } from "../store/auth";
import { theme } from "../theme";

type UserResult = {
  id: string;
  username: string;
  fullName?: string;
  avatarUrl?: string | null;
  isVerified?: boolean;
  bio?: string;
  followersCount?: number;
  isOnline?: boolean;
  lastSeen?: string;
};

type ConversationResponse = {
  id: string;
  type: "direct" | "group";
  name?: string;
  avatarUrl?: string;
  participants?: Array<{
    user: UserResult;
  }>;
};

const COLORS = {
  bg: "#FFFFFF",
  card: "#FFFFFF",
  soft: "#F6F8FF",
  softer: "#EEF3FF",
  text: "#101828",
  muted: "#667085",
  faint: "#98A2B3",
  border: "#E8ECF5",
  neon: theme?.colors?.neonCyan || theme?.colors?.neon || "#00F5D4",
  gold: theme?.colors?.premiumGold || theme?.colors?.gold || "#D4AF37",
  violet: theme?.colors?.electricViolet || "#7B61FF",
  danger: "#FF4757",
  success: "#2ED573",
  charcoal: theme?.colors?.deepCharcoal || "#1A1A2E"
};

const avatarFor = (name?: string, avatarUrl?: string | null) => {
  if (avatarUrl && typeof avatarUrl === "string" && avatarUrl.trim().length > 0) return avatarUrl;
  const seed = encodeURIComponent(name || "Texa User");
  return `https://api.dicebear.com/7.x/initials/png?seed=${seed}&backgroundColor=00F5D4,7B61FF,D4AF37&textColor=ffffff`;
};

const normalizeUsers = (payload: any): UserResult[] => {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.users) ? payload.users : Array.isArray(payload?.data) ? payload.data : [];
  return raw
    .filter(Boolean)
    .map((u: any) => ({
      id: String(u.id),
      username: String(u.username || u.handle || "user"),
      fullName: u.fullName || u.name || "",
      avatarUrl: u.avatarUrl || u.avatar || null,
      isVerified: Boolean(u.isVerified || u.verified),
      bio: u.bio || "",
      followersCount: Number(u.followersCount || u.followers?.length || 0),
      isOnline: Boolean(u.isOnline),
      lastSeen: u.lastSeen
    }))
    .filter((u: UserResult) => u.id && u.username);
};

const uniqueById = (items: UserResult[]) => {
  const map = new Map<string, UserResult>();
  items.forEach(item => map.set(item.id, item));
  return Array.from(map.values());
};

const SelectedChip = memo(({ user, onRemove }: { user: UserResult; onRemove: (id: string) => void }) => {
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.chip} onPress={() => onRemove(user.id)}>
      <Image source={{ uri: avatarFor(user.username, user.avatarUrl) }} style={styles.chipAvatar} />
      <Text style={styles.chipText} numberOfLines={1}>
        {user.username}
      </Text>
      <Text style={styles.chipClose}>×</Text>
    </TouchableOpacity>
  );
});

const UserRow = memo(
  ({
    item,
    selected,
    disabled,
    onPress
  }: {
    item: UserResult;
    selected: boolean;
    disabled: boolean;
    onPress: (user: UserResult) => void;
  }) => {
    const scale = useRef(new Animated.Value(1)).current;

    const pressIn = () => {
      Animated.timing(scale, {
        toValue: 0.98,
        duration: 90,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true
      }).start();
    };

    const pressOut = () => {
      Animated.spring(scale, {
        toValue: 1,
        tension: 130,
        friction: 9,
        useNativeDriver: true
      }).start();
    };

    return (
      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable
          onPressIn={pressIn}
          onPressOut={pressOut}
          onPress={() => onPress(item)}
          disabled={disabled}
          style={({ pressed }) => [styles.userRow, selected && styles.userRowSelected, disabled && styles.userRowDisabled, pressed && styles.userRowPressed]}
        >
          <View style={styles.avatarWrap}>
            <Image source={{ uri: avatarFor(item.username, item.avatarUrl) }} style={styles.avatar} />
            {item.isOnline ? <View style={styles.onlineDot} /> : null}
          </View>

          <View style={styles.userInfo}>
            <View style={styles.nameLine}>
              <Text style={styles.username} numberOfLines={1}>
                {item.username}
              </Text>
              {item.isVerified ? <Text style={styles.verified}>✓</Text> : null}
            </View>
            <Text style={styles.fullname} numberOfLines={1}>
              {item.fullName || item.bio || "Texa member"}
            </Text>
            {item.followersCount ? (
              <Text style={styles.meta} numberOfLines={1}>
                {item.followersCount.toLocaleString()} followers
              </Text>
            ) : null}
          </View>

          <View style={[styles.selectCircle, selected && styles.selectCircleActive]}>
            {selected ? <Text style={styles.selectTick}>✓</Text> : null}
          </View>
        </Pressable>
      </Animated.View>
    );
  }
);

export default function NewChatScreen({ navigation }: any) {
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<UserResult[]>([]);
  const [isGroup, setIsGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recentUsers, setRecentUsers] = useState<UserResult[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const headerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(headerAnim, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start();
    loadRecentUsers();
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const selectedIds = useMemo(() => selectedUsers.map(u => u.id), [selectedUsers]);

  const canCreate = useMemo(() => {
    if (creating) return false;
    if (isGroup) return selectedUsers.length >= 2 && groupName.trim().length >= 2;
    return selectedUsers.length === 1;
  }, [creating, groupName, isGroup, selectedUsers.length]);

  const visibleUsers = useMemo(() => {
    const base = searchQuery.trim().length >= 2 ? results : recentUsers;
    return uniqueById(base).filter(u => u.id !== user?.id);
  }, [recentUsers, results, searchQuery, user?.id]);

  const title = isGroup ? "New Group" : "New Message";
  const subtitle = isGroup ? `${selectedUsers.length} selected` : selectedUsers.length === 1 ? `Chat with @${selectedUsers[0]?.username}` : "Choose one person";

  const loadRecentUsers = useCallback(async () => {
    try {
      const res = await api.get("/user/search", { params: { q: "", limit: 20, recent: true } });
      setRecentUsers(normalizeUsers(res.data).filter(u => u.id !== user?.id));
    } catch {
      setRecentUsers([]);
    }
  }, [user?.id]);

  const searchUsersNow = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (q.length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }

      const current = ++requestId.current;
      setLoading(true);

      try {
        const res = await api.get("/user/search", { params: { q, limit: 30 } });
        if (current !== requestId.current) return;
        setResults(normalizeUsers(res.data).filter(u => u.id !== user?.id));
      } catch {
        if (current !== requestId.current) return;
        setResults([]);
      } finally {
        if (current === requestId.current) setLoading(false);
      }
    },
    [user?.id]
  );

  const handleSearchChange = useCallback(
    (text: string) => {
      setSearchQuery(text);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (text.trim().length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      searchTimer.current = setTimeout(() => searchUsersNow(text), 280);
    },
    [searchUsersNow]
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (searchQuery.trim().length >= 2) await searchUsersNow(searchQuery);
    else await loadRecentUsers();
    setRefreshing(false);
  }, [loadRecentUsers, searchQuery, searchUsersNow]);

  const toggleMode = useCallback(
    (nextGroup: boolean) => {
      setIsGroup(nextGroup);
      setSelectedUsers(prev => {
        if (nextGroup) return prev;
        return prev.slice(0, 1);
      });
    },
    []
  );

  const toggleSelect = useCallback(
    (target: UserResult) => {
      setSelectedUsers(prev => {
        const exists = prev.some(u => u.id === target.id);
        if (exists) return prev.filter(u => u.id !== target.id);
        if (!isGroup) return [target];
        return [...prev, target];
      });
    },
    [isGroup]
  );

  const removeSelected = useCallback((id: string) => {
    setSelectedUsers(prev => prev.filter(u => u.id !== id));
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setResults([]);
    setLoading(false);
    Keyboard.dismiss();
  }, []);

  const createChat = useCallback(async () => {
    if (creating) return;

    if (isGroup && selectedUsers.length < 2) {
      Alert.alert("Group needs members", "Select at least 2 people to create a group.");
      return;
    }

    if (isGroup && groupName.trim().length < 2) {
      Alert.alert("Group name required", "Enter a group name with at least 2 characters.");
      return;
    }

    if (!isGroup && selectedUsers.length !== 1) {
      Alert.alert("Select one user", "Choose one person to start a direct chat.");
      return;
    }

    setCreating(true);

    try {
      const payload = {
        type: isGroup ? "group" : "direct",
        name: isGroup ? groupName.trim() : undefined,
        participantIds: selectedUsers.map(u => u.id)
      };

      const res = await api.post("/dm/conversations", payload);
      const data: ConversationResponse = res.data;

      if (isGroup) {
        navigation.replace("Chat", {
          conversationId: data.id,
          title: data.name || groupName.trim(),
          participant: null
        });
      } else {
        const other =
          data.participants?.find(p => p?.user?.id !== user?.id)?.user ||
          selectedUsers[0];

        navigation.replace("Chat", {
          conversationId: data.id,
          title: other?.username || selectedUsers[0]?.username,
          participant: other || selectedUsers[0]
        });
      }
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.response?.data?.message || "Unable to create chat right now.";
      Alert.alert("Chat not created", message);
    } finally {
      setCreating(false);
    }
  }, [creating, groupName, isGroup, navigation, selectedUsers, user?.id]);

  const renderUser = useCallback(
    ({ item }: { item: UserResult }) => {
      const selected = selectedIds.includes(item.id);
      return <UserRow item={item} selected={selected} disabled={creating} onPress={toggleSelect} />;
    },
    [creating, selectedIds, toggleSelect]
  );

  const listEmpty = useMemo(() => {
    if (loading) {
      return (
        <View style={styles.empty}>
          <ActivityIndicator color={COLORS.neon} size="large" />
          <Text style={styles.emptyTitle}>Searching users</Text>
          <Text style={styles.emptyText}>Finding the best matches for your chat.</Text>
        </View>
      );
    }

    if (searchQuery.trim().length >= 2) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={styles.emptyTitle}>No users found</Text>
          <Text style={styles.emptyText}>Try a username, full name, or a shorter search.</Text>
        </View>
      );
    }

    return (
      <View style={styles.empty}>
        <Text style={styles.emptyIcon}>💬</Text>
        <Text style={styles.emptyTitle}>Search people</Text>
        <Text style={styles.emptyText}>Type at least 2 letters to start a direct chat or create a group.</Text>
      </View>
    );
  }, [loading, searchQuery]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.bg} />
      <View style={styles.container}>
        <Animated.View
          style={[
            styles.hero,
            {
              opacity: headerAnim,
              transform: [
                {
                  translateY: headerAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-16, 0]
                  })
                }
              ]
            }
          ]}
        >
          <View style={styles.header}>
            <TouchableOpacity activeOpacity={0.75} onPress={() => navigation.goBack()} style={styles.backButton}>
              <Text style={styles.back}>‹</Text>
            </TouchableOpacity>

            <View style={styles.headerCenter}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>

            <TouchableOpacity activeOpacity={0.8} onPress={createChat} disabled={!canCreate} style={[styles.doneButton, !canCreate && styles.doneButtonDisabled]}>
              {creating ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.done}>Done</Text>}
            </TouchableOpacity>
          </View>

          <View style={styles.modeCard}>
            <TouchableOpacity activeOpacity={0.9} onPress={() => toggleMode(false)} style={[styles.modeButton, !isGroup && styles.modeButtonActive]}>
              <Text style={[styles.modeText, !isGroup && styles.modeTextActive]}>Direct</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.9} onPress={() => toggleMode(true)} style={[styles.modeButton, isGroup && styles.modeButtonActive]}>
              <Text style={[styles.modeText, isGroup && styles.modeTextActive]}>Group</Text>
            </TouchableOpacity>
          </View>

          {isGroup ? (
            <View style={styles.groupBox}>
              <View style={styles.groupIcon}>
                <Text style={styles.groupIconText}>#</Text>
              </View>
              <TextInput
                placeholder="Group name"
                placeholderTextColor={COLORS.faint}
                value={groupName}
                onChangeText={setGroupName}
                style={styles.groupNameInput}
                maxLength={40}
                returnKeyType="next"
              />
              <Text style={styles.counter}>{groupName.trim().length}/40</Text>
            </View>
          ) : null}

          {selectedUsers.length > 0 ? (
            <FlatList
              horizontal
              data={selectedUsers}
              keyExtractor={item => item.id}
              renderItem={({ item }) => <SelectedChip user={item} onRemove={removeSelected} />}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipsList}
            />
          ) : null}

          <View style={styles.searchBox}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput
              placeholder="Search users..."
              placeholderTextColor={COLORS.faint}
              value={searchQuery}
              onChangeText={handleSearchChange}
              style={styles.search}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => searchUsersNow(searchQuery)}
            />
            {searchQuery.length > 0 ? (
              <TouchableOpacity activeOpacity={0.75} onPress={clearSearch} style={styles.clearButton}>
                <Text style={styles.clearText}>×</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Animated.View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{searchQuery.trim().length >= 2 ? "Search Results" : "Suggested"}</Text>
          <Text style={styles.sectionCount}>{visibleUsers.length}</Text>
        </View>

        <FlatList
          data={visibleUsers}
          keyExtractor={item => item.id}
          renderItem={renderUser}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.neon} colors={[COLORS.neon]} />}
          ListEmptyComponent={listEmpty}
          contentContainerStyle={visibleUsers.length ? styles.listContent : styles.emptyContent}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={9}
          removeClippedSubviews={Platform.OS === "android"}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.bg
  },
  hero: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: COLORS.bg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border
  },
  header: {
    height: 54,
    flexDirection: "row",
    alignItems: "center"
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: COLORS.soft,
    alignItems: "center",
    justifyContent: "center"
  },
  back: {
    fontSize: 34,
    lineHeight: 36,
    color: COLORS.charcoal,
    fontWeight: "500",
    marginTop: -2
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 10
  },
  title: {
    fontSize: 19,
    fontWeight: "800",
    color: COLORS.text,
    letterSpacing: -0.3
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.muted
  },
  doneButton: {
    minWidth: 68,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: COLORS.neon,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: COLORS.neon,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4
  },
  doneButtonDisabled: {
    opacity: 0.45,
    shadowOpacity: 0,
    elevation: 0
  },
  done: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "900"
  },
  modeCard: {
    marginTop: 12,
    padding: 4,
    borderRadius: 24,
    backgroundColor: COLORS.soft,
    flexDirection: "row",
    borderWidth: 1,
    borderColor: COLORS.border
  },
  modeButton: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center"
  },
  modeButtonActive: {
    backgroundColor: COLORS.charcoal,
    shadowColor: COLORS.charcoal,
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3
  },
  modeText: {
    color: COLORS.muted,
    fontWeight: "800",
    fontSize: 14
  },
  modeTextActive: {
    color: "#FFFFFF"
  },
  groupBox: {
    marginTop: 12,
    minHeight: 54,
    borderRadius: 18,
    backgroundColor: COLORS.soft,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12
  },
  groupIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.gold,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10
  },
  groupIconText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900"
  },
  groupNameInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
    paddingVertical: Platform.OS === "ios" ? 12 : 8
  },
  counter: {
    color: COLORS.faint,
    fontSize: 11,
    fontWeight: "700",
    marginLeft: 8
  },
  chipsList: {
    paddingTop: 12,
    paddingBottom: 2
  },
  chip: {
    height: 38,
    maxWidth: 150,
    paddingLeft: 4,
    paddingRight: 10,
    marginRight: 8,
    borderRadius: 19,
    backgroundColor: COLORS.charcoal,
    flexDirection: "row",
    alignItems: "center"
  },
  chipAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: 7
  },
  chipText: {
    maxWidth: 86,
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800"
  },
  chipClose: {
    color: COLORS.neon,
    fontSize: 18,
    fontWeight: "800",
    marginLeft: 6,
    marginTop: -1
  },
  searchBox: {
    marginTop: 12,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.soft,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14
  },
  searchIcon: {
    fontSize: 24,
    color: COLORS.faint,
    marginRight: 8,
    marginTop: -2
  },
  search: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "600",
    paddingVertical: Platform.OS === "ios" ? 13 : 8
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.softer,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8
  },
  clearText: {
    fontSize: 20,
    lineHeight: 22,
    color: COLORS.muted,
    fontWeight: "700",
    marginTop: -1
  },
  sectionHeader: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center"
  },
  sectionTitle: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 0.2
  },
  sectionCount: {
    minWidth: 28,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    overflow: "hidden",
    backgroundColor: COLORS.soft,
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: "900",
    textAlign: "center",
    lineHeight: 22
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 28
  },
  emptyContent: {
    flexGrow: 1,
    paddingHorizontal: 18,
    paddingBottom: 28
  },
  userRow: {
    minHeight: 76,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#101828",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2
  },
  userRowPressed: {
    opacity: 0.92
  },
  userRowSelected: {
    borderColor: COLORS.neon,
    backgroundColor: "#F0FFFC",
    shadowColor: COLORS.neon,
    shadowOpacity: 0.16
  },
  userRowDisabled: {
    opacity: 0.7
  },
  avatarWrap: {
    width: 52,
    height: 52,
    borderRadius: 26
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.softer
  },
  onlineDot: {
    position: "absolute",
    right: 1,
    bottom: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: COLORS.success,
    borderWidth: 2,
    borderColor: "#FFFFFF"
  },
  userInfo: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8
  },
  nameLine: {
    flexDirection: "row",
    alignItems: "center"
  },
  username: {
    maxWidth: "86%",
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: -0.1
  },
  verified: {
    marginLeft: 5,
    color: COLORS.neon,
    fontSize: 14,
    fontWeight: "900"
  },
  fullname: {
    marginTop: 3,
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: "600"
  },
  meta: {
    marginTop: 3,
    color: COLORS.faint,
    fontSize: 11,
    fontWeight: "700"
  },
  selectCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF"
  },
  selectCircleActive: {
    borderColor: COLORS.neon,
    backgroundColor: COLORS.neon
  },
  selectTick: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "900"
  },
  empty: {
    flex: 1,
    minHeight: 320,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28
  },
  emptyIcon: {
    fontSize: 42,
    marginBottom: 14
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center"
  },
  emptyText: {
    marginTop: 8,
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "600",
    textAlign: "center"
  }
});
