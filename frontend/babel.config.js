module.exports = function (api) {
  api.cache(true);

  const aliases = {
    "@": "./src",
    "@app": "./app",
    "@assets": "./assets",
    "@components": "./src/components",
    "@screens": "./src/screens",
    "@navigation": "./src/navigation",
    "@store": "./src/store",
    "@api": "./src/api",
    "@theme": "./src/theme",
    "@hooks": "./src/hooks",
    "@utils": "./src/utils",
    "@services": "./src/services",
    "@features": "./src/features",
    "@types": "./src/types",
    "@constants": "./src/constants",
    "@config": "./src/config",
    "@lib": "./src/lib"
  };

  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          cwd: "babelrc",
          extensions: [
            ".ios.ts",
            ".android.ts",
            ".native.ts",
            ".ts",
            ".ios.tsx",
            ".android.tsx",
            ".native.tsx",
            ".tsx",
            ".ios.js",
            ".android.js",
            ".native.js",
            ".jsx",
            ".js",
            ".json"
          ],
          alias: aliases
        }
      ],
      "react-native-reanimated/plugin"
    ]
  };
};
