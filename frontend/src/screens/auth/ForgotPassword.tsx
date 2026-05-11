import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { api } from '../../api/client';
import { theme } from '../../theme';
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const handle = async () => {
    try { await api.post('/auth/forgot', { email }); Alert.alert('Reset link sent'); } catch { Alert.alert('Failed'); }
  };
  return (
    <View style={styles.container}>
      <Text style={styles.title}>RESET PASSWORD</Text>
      <TextInput placeholder="Email" value={email} onChangeText={setEmail} style={styles.input} keyboardType="email-address" />
      <TouchableOpacity onPress={handle} style={styles.btn}><Text style={styles.btnText}>SEND RESET LINK</Text></TouchableOpacity>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', padding: 30, backgroundColor: '#fff' }, title: { fontSize: 22, fontWeight: '800', color: theme.colors.neon, marginBottom: 20 }, input: { backgroundColor: theme.colors.softWhite, padding: 15, borderRadius: 12, marginBottom: 15 }, btn: { backgroundColor: theme.colors.gold, padding: 15, borderRadius: 12, alignItems: 'center' }, btnText: { color: '#fff', fontWeight: '700' } });
