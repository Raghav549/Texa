import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { QRCodeSVG } from 'react-native-qrcode-svg';
import { useUserStore } from '../store/useUserStore';
import { theme } from '../theme';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

export default function PrestigeCard() {
  const { user } = useUserStore();
  const profileUrl = `https://texa.app/u/${user?.username}`;

  const downloadShare = async () => {
    const html = `
      <html><head><style>
        body{margin:0;padding:20px;background:#000;display:flex;justify-content:center}
        .card{width:800px;height:450px;background:#fff;border-radius:20px;display:flex;flex-direction:column;padding:30px;box-shadow:0 10px 40px rgba(0,0,0,0.3)}
        .row{display:flex;justify-content:space-between;align-items:center}
        h1{margin:0;color:#D4A857;font-size:32px}
        .data{color:#1A1A1A;font-size:18px;margin-top:8px}
        .stats{display:flex;gap:20px;margin-top:16px}
      </style></head><body>
        <div class="card">
          <div class="row"><img src="${user?.avatarUrl}" width="80" height="80" style="border-radius:50px;object-fit:cover"><div><h1>TEXA PRESTIGE</h1><div class="data">@${user?.username}</div><div class="data">${user?.bio}</div></div><svg id="qr" data-url="${profileUrl}"></svg></div>
          <div class="stats">
            <div>Followers: ${user?.followers?.length || 0}</div>
            <div>Following: ${user?.following?.length || 0}</div>
            <div>XP: ${user?.xp} | Level: ${user?.level}</div>
          </div>
        </div>
      </body></html>`;

    const { uri } = await Print.printToFileAsync({ html, width: 3840, height: 2160 });
    await Sharing.shareAsync(uri);
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Image source={{ uri: user?.avatarUrl }} style={styles.avatar} />
        <View>
          <Text style={styles.name}>{user?.fullName}</Text>
          <Text style={styles.username}>@{user?.username}</Text>
          {user?.isVerified && <Text style={styles.badge}>VERIFIED</Text>}
        </View>
      </View>
      <View style={styles.stats}>
        <Text style={styles.stat}>{user?.followers?.length || 0} Followers</Text>
        <Text style={styles.stat}>{user?.following?.length || 0} Following</Text>
        <Text style={styles.stat}>Level: {user?.level} | XP: {user?.xp}</Text>
      </View>
      <View style={styles.qr}><QRCodeSVG value={profileUrl} size={80} /></View>
      <TouchableOpacity style={styles.btn} onPress={downloadShare}>
        <Text style={styles.btnText}>DOWNLOAD 4K & SHARE</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.colors.white, borderRadius: 16, padding: 20, margin: 10, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  avatar: { width: 60, height: 60, borderRadius: 30, marginRight: 15 },
  name: { fontSize: 18, fontWeight: '800', color: theme.colors.text },
  username: { fontSize: 14, color: theme.colors.gold },
  badge: { fontSize: 10, backgroundColor: theme.colors.neonBlue, color: '#fff', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 4 },
  stats: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  stat: { fontSize: 12, color: theme.colors.muted },
  qr: { alignItems: 'center', marginBottom: 15 },
  btn: { backgroundColor: theme.colors.gold, padding: 12, borderRadius: 8, alignItems: 'center' },
  btnText: { color: theme.colors.white, fontWeight: '700' }
});
