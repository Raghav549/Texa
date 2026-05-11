import React, { useEffect, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, FlatList, ScrollView } from 'react-native';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { theme } from '../theme';
import PrestigeCard from '../components/PrestigeCard';

export default function Profile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [isFollowing, setIsFollowing] = useState(false);

  useEffect(() => { if (user) api.get(`/users/${user.id}`).then(res => setProfile(res.data)); }, [user]);
  if (!profile) return <Text>Loading...</Text>;

  const handleFollow = async () => {
    await api.post(`/users/${user.id}/follow`);
    setIsFollowing(!isFollowing);
  };

  return (
    <ScrollView style={styles.container}>
      <Image source={{ uri: profile.avatarUrl }} style={styles.avatar} />
      <Text style={styles.name}>{profile.fullName} {profile.isVerified && <Text style={styles.badge}>✓</Text>}</Text>
      <Text style={styles.username}>@{profile.username}</Text>
      <Text style={styles.bio}>{profile.bio}</Text>
      <View style={styles.stats}><Text>{profile.followers?.length || 0} Followers</Text><Text>{profile.following?.length || 0} Following</Text><Text>Lvl {profile.level} | {profile.xp} XP</Text></View>
      <View style={styles.actions}><TouchableOpacity style={styles.btn}><Text style={styles.btnText}>Message</Text></TouchableOpacity><TouchableOpacity onPress={handleFollow} style={[styles.btn, { backgroundColor: isFollowing ? theme.colors.gold : theme.colors.neon }]}><Text style={styles.btnText}>{isFollowing ? 'Unfollow' : 'Follow'}</Text></TouchableOpacity></View>
      <PrestigeCard user={profile} />
      <FlatList horizontal data={profile.stories || []} keyExtractor={i => i.id} renderItem={({ item }) => <Image source={{ uri: item.mediaUrl }} style={{ width: 100, height: 150, borderRadius: 10, margin: 5 }} />} />
    </ScrollView>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: theme.colors.white, padding: 20 }, avatar: { width: 100, height: 100, borderRadius: 50, alignSelf: 'center', marginBottom: 10 }, name: { fontSize: 22, fontWeight: '800', textAlign: 'center' }, username: { fontSize: 14, color: theme.colors.gold, textAlign: 'center' }, bio: { fontSize: 15, color: theme.colors.gray, textAlign: 'center', marginVertical: 10 }, stats: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 20 }, actions: { flexDirection: 'row', justifyContent: 'center', gap: 15, marginBottom: 20 }, btn: { padding: 12, borderRadius: 8 }, btnText: { color: '#fff', fontWeight: '600' }, badge: { color: theme.colors.neon, fontSize: 18 } });
