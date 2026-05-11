# TEXA PRODUCTION APK BUILD PIPELINE

## 1. PREREQUISITES
- Node.js 18+
- EAS CLI: `npm install -g eas-cli`
- Expo Account: `eas login`
- Android SDK / JDK 17 (for local builds)

## 2. CONFIGURE CREDENTIALS
```bash
cd frontend
eas build:configure
eas credentials:configure android
# Follow prompts to generate/upload keystore & keystore password
