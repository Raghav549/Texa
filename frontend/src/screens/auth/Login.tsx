import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useAuth } from '../../store/auth';
import { theme } from '../../theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const { login } = useAuth();
  const handle = async () => { try { await login(email, pass); } catch { Alert.alert('Invalid credentials'); } };
  return (
    <View style={styles.container}><Text style={styles.title}>TEXA</Text><TextInput placeholder="Email" value={email} onChangeText={setEmail} style={styles.input} /><TextInput placeholder="Password" value={pass} onChangeText={setPass} style={styles.input} secureTextEntry /><TouchableOpacity onPress={handle} style={styles.btn}><Text style={styles.btnText}>LOGIN</Text></TouchableOpacity><TouchableOpacity><Text style={styles.link}>Forgot Password?</Text></TouchableOpacity></View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, backgroundColor: theme.colors.white }, title: { fontSize: 32, fontWeight: '900', color: theme.colors.neon, marginBottom: 40 }, input: { width: '100%', padding: 15, backgroundColor: theme.colors.softWhite, borderRadius: 12, marginBottom: 15, fontSize: 16 }, btn: { width: '100%', backgroundColor: theme.colors.gold, padding: 15, borderRadius: 12, alignItems: 'center' }, btnText: { color: '#fff', fontSize: 18, fontWeight: '700' }, link: { marginTop: 15, color: theme.colors.gray } });
