# Mobile emulator tests

`bash autonomy/mobile-verify.sh [project_dir]`

Detects React Native/Expo (package.json) or Flutter (pubspec.yaml). Looks for a booted Android emulator (`adb devices`) or iOS simulator (`xcrun simctl list devices booted`).

Test command: `LOKI_MOBILE_TEST_CMD`, else `flutter test [integration_test]`, else `npm run test:e2e` / `npm run e2e`.

Exit codes: 0 ran and passed (or not a mobile project, stated); 1 ran and failed; 3 NOT VERIFIED (no device or no e2e script). A NOT VERIFIED result must never be reported as a pass.

Timeout: `LOKI_MOBILE_TIMEOUT` seconds (default 600).
