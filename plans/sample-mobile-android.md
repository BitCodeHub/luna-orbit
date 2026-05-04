---
name: Sample · Android — generic Appium smoke
platform: mobile
mobile_mode: appium
capabilities: {"platformName":"Android","appium:automationName":"UiAutomator2","appium:appPackage":"com.android.settings","appium:appActivity":".Settings","appium:noReset":true}
max_steps_per_intent: 6
---

## Steps
1. Tap the "Network & internet" entry
2. Tap "Internet" (or "Wi-Fi" depending on the Android version)
3. Verify the Wi-Fi toggle is visible

## Assertions
- The current screen shows a Wi-Fi toggle or list of nearby networks
- No error dialog is visible
