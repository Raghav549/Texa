import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { theme } from '../theme';
export default function NotificationBadge() {
  const nav = useNavigation();
  return (
    <TouchableOpacity onPress={() => nav.navigate('Notifications' as never)} style={styles.badge}>
      <Text style={styles.icon}>🔔</Text>
      <View style={styles.dot} />
    </TouchableOpacity>
  );
}
const styles = StyleSheet.create({ badge: { padding: 8, position: 'relative' }, icon: { fontSize: 20 }, dot: { position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.gold } });
