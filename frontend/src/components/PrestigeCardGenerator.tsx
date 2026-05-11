import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Print from 'expo-print';
import { theme } from '../theme';
import { useAuth } from '../store/auth';

export default function PrestigeCardGenerator() {
  const { user } = useAuth();
  const exportCard = async () => {
    const html = `
      <div style="width:3840px;height:2160px;background:#fff;border:80px solid #D4A857;display:flex;flex-direction:column;padding:200px;font-family:sans-serif">
        <div style="display:flex;align-items:center;margin-bottom:100px">
          <img src="${user?.avatarUrl || ''}" style="width:400px;height:400px;border-radius:200px;object-fit:cover;border:20px solid #EAEAEA"/>
          <div style="margin-left:100px">
            <h1 style="margin:0;font-size:120px;color:#D4A857;letter-spacing:4px">TEXA PRESTIGE</h1>
            <p style="margin:20px 0;font-size:80px;color:#1A1A1A;font-weight:800">${user?.fullName}</p>
            <p style="margin:0;font-size:60px;color:#00E0FF;font-weight:700">@${user?.username}</p>
          </div>
        </div>
        <p style="font-size:70px;color:#555;margin:40px 0">${user?.bio || 'Texa Official Member'}</p>
        <div style="display:flex;gap:100px;margin:100px 0">
          <div style="font-size:80px"><strong>${user?.followers?.length || 0}</strong> Followers</div>
          <div style="font-size:80px"><strong>${user?.following?.length || 0}</strong> Following</div>
          <div style="font-size:80px"><strong>${user?.level}</strong> Level</div>
        </div>
        <div style="margin-top:100px;font-size:60px;color:#888">ID: ${user?.id} | DOB: ${new Date(user?.dob || '').toLocaleDateString()}</div>
        <svg id="qr-code" style="position:absolute;right:200px;top:200px"></svg>
      </div>
    `;
    const { uri } = await Print.printToFileAsync({ html, width: 3840, height: 2160 });
    await Share.share({ title: 'My Texa Prestige Card', message: 'Check out my Texa digital prestige card!', url: uri });
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <QRCode value={`https://texa.app/u/${user?.username}`} size={100} />
        <View>
          <Text style={styles.title}>TEXA PRESTIGE</Text>
          <Text style={styles.name}>{user?.fullName} {user?.isVerified ? '🔹' : ''}</Text>
          <Text style={styles.username}>@{user?.username}</Text>
        </View>
      </View>
      <Text style={styles.bio}>{user?.bio}</Text>
      <View style={styles.stats}>
        <Text style={styles.stat}>{user?.followers?.length || 0} Followers</Text>
        <Text style={styles.stat}>{user?.following?.length || 0} Following</Text>
        <Text style={styles.stat}>{user?.level} Lvl | {user?.xp} XP</Text>
      </View>
      <TouchableOpacity onPress={exportCard} style={styles.btn}>
        <Text style={styles.btnText}>DOWNLOAD 4K & SHARE</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 20, margin: 15, borderWidth: 2, borderColor: theme.colors.gold },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  title: { fontSize: 18, fontWeight: '900', color: theme.colors.gold },
  name: { fontSize: 20, fontWeight: '800', marginTop: 5 },
  username: { color: theme.colors.neon, fontWeight: '600' },
  bio: { fontSize: 14, color: '#666', marginBottom: 15 },
  stats: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  stat: { fontSize: 13, color: '#444', fontWeight: '600' },
  btn: { backgroundColor: theme.colors.gold, padding: 14, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 14 }
});
