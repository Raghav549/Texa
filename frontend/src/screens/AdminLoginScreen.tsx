import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { api } from '../api/client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { theme } from '../theme';
export default function AdminLoginScreen({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const handle = async () => {
    try {
      const { data } = await api.post('/admin/login', { email, password: pass });
      await AsyncStorage.setItem('admin_token', data.token);
      onLogin();
    } catch { Alert.alert('Invalid Admin Credentials'); }
  };
  return (
    <View style={styles.container}>
      <Text style={styles.title}>ADMIN ACCESS</Text>
      <TextInput placeholder="Admin Email" value={email} onChangeText={setEmail} style={styles.input} />
      <TextInput placeholder="Password" value={pass} onChangeText={setPass} style={styles.input} secureTextEntry />
      <TouchableOpacity onPress={handle} style={styles.btn}><Text style={styles.btnText}>ENTER PANEL</Text></TouchableOpacity>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', padding: 30, backgroundColor: '#000' }, title: { fontSize: 24, fontWeight: '900', color: theme.colors.neon, marginBottom: 30, textAlign: 'center' }, input: { backgroundColor: '#222', color: '#fff', padding: 15, borderRadius: 10, marginBottom: 15 }, btn: { backgroundColor: theme.colors.gold, padding: 15, borderRadius: 10, alignItems: 'center' }, btnText: { color: '#000', fontWeight: '800' } });
