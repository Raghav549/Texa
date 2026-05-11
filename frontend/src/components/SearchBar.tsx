import React, { useState, useEffect } from 'react';
import { View, TextInput, FlatList, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
export default function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  useEffect(() => {
    if (query.length > 2) {
      api.get(`/users/search?q=${query}`).then(res => setResults(res.data)).catch(() => setResults([]));
    } else setResults([]);
  }, [query]);
  return (
    <View style={styles.container}>
      <TextInput placeholder="Search usernames..." value={query} onChangeText={setQuery} style={styles.input} />
      {results.length > 0 && (
        <FlatList data={results} keyExtractor={u => u.id} renderItem={({ item }) => (
          <TouchableOpacity style={styles.result}><Text style={styles.name}>@{item.username}</Text><Text style={styles.full}>{item.fullName}</Text></TouchableOpacity>
        )} style={styles.dropdown} />
      )}
    </View>
  );
}
const styles = StyleSheet.create({ container: { position: 'absolute', top: 10, left: 20, right: 20, zIndex: 10 }, input: { backgroundColor: '#fff', padding: 12, borderRadius: 25, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5 }, dropdown: { backgroundColor: '#fff', borderRadius: 15, marginTop: 5, maxHeight: 200 }, result: { padding: 15, borderBottomWidth: 1, borderColor: '#eee' }, name: { fontWeight: '700', fontSize: 16 }, full: { fontSize: 12, color: theme.colors.gray } });
