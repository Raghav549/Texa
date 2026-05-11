import React, { useState } from 'react';
import { View, TextInput, Button, Alert, Text, StyleSheet, Image, TouchableOpacity } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { theme } from '../../theme';
import api from '../../api/client';
import { useUserStore } from '../../store/useUserStore';

export default function SignupScreen() {
  const [form, setForm] = useState({ fullName: '', username: '', email: '', password: '', dob: '', bio: '' });
  const [avatar, setAvatar] = useState<string | null>(null);
  const { setUser, setToken } = useUserStore();

  const pickAvatar = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!res.canceled) setAvatar(res.assets[0].uri);
  };

  const handleSignup = async () => {
    try {
      const fd = new FormData();
      if (avatar) fd.append('avatar', { uri: avatar, name: 'avatar.jpg', type: 'image/jpeg' } as any);
      Object.entries(form).forEach(([k, v]) => fd.append(k, v as string));

      const { data } = await api.post('/auth/register', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setToken(data.token);
      setUser(data.user);
    } catch (err: any) {
      Alert.alert('Signup Failed', err.message || 'Server error');
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={pickAvatar} style={styles.avatarBtn}>
        <Text style={{color: theme.colors.gold}}>Upload Profile</Text>
      </TouchableOpacity>
      {['fullName','username','email','password','dob','bio'].map((key, i) => (
        <TextInput key={key} placeholder={key.toUpperCase()} style={styles.input} value={form[key]} onChangeText={(v)=>setForm(f=>({...f,[key]:v}))} />
      ))}
      <Button title="JOIN TEXA" color={theme.colors.neonBlue} onPress={handleSignup} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.white, justifyContent: 'center' },
  avatarBtn: { alignItems: 'center', marginBottom: theme.spacing.lg, padding: theme.spacing.lg, borderWidth: 1, borderColor: theme.colors.lightSilver, borderRadius: 8 },
  input: { backgroundColor: theme.colors.softWhite, padding: theme.spacing.md, borderRadius: 8, marginBottom: theme.spacing.md }
});
