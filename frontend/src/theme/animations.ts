import { Animated, Easing } from 'react-native';
export const fadeIn = (ref: any, duration = 300) => Animated.timing(ref, { toValue: 1, duration, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
export const scaleUp = (ref: any) => Animated.sequence([Animated.timing(ref, { toValue: 1.1, duration: 150, useNativeDriver: true }), Animated.timing(ref, { toValue: 1, duration: 150, useNativeDriver: true })]).start();
export const slideUp = (ref: any) => Animated.spring(ref, { toValue: 1, tension: 40, friction: 10, useNativeDriver: true }).start();
