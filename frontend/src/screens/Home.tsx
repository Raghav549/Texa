import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
export default function Home() {
  return (
    <View style={styles.container}><Text style={styles.header}>WELCOME TO TEXA</Text><Text style={styles.sub}>Real social universe. Zero placeholders.</Text><TouchableOpacity style={styles.btn}><Text style={styles.btnText}>Explore</Text></TouchableOpacity></View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.white }, header: { fontSize: 28, fontWeight: '800', color: theme.colors.neon, marginBottom: 10 }, sub: { fontSize: 16, color: theme.colors.gray, marginBottom: 30 }, btn: { backgroundColor: theme.colors.gold, padding: 15, borderRadius: 12 }, btnText: { color: '#fff', fontSize: 18, fontWeight: '700' } });
