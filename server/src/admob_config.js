'use strict';

// AdMob identifiers are public integration settings, not credentials. Keep the
// created unit here so a deployment does not require copying an env variable.
const PUBLISHER_ID = 'pub-6003559032392528';
const DEFAULT_UNITS = Object.freeze({
  android: 'ca-app-pub-6003559032392528/9595839204',
  ios: 'ca-app-pub-6003559032392528/8446409063',
});

function validAdmobUnits(source) {
  return Object.fromEntries(Object.entries(source).filter(([platform, unit]) =>
    ['android', 'ios'].includes(platform) && /^ca-app-pub-\d{16}\/\d{10}$/.test(unit ?? '') &&
    !unit.startsWith('ca-app-pub-3940256099942544/')));
}

function readAdmobUnits(env = process.env) {
  return validAdmobUnits({
    // Nullish fallback is intentional: an explicitly empty env setting disables
    // that platform, while an absent setting uses its checked-in public unit.
    android: env.BUNNY_ADMOB_ANDROID_REWARDED_UNIT ?? DEFAULT_UNITS.android,
    ios: env.BUNNY_ADMOB_IOS_REWARDED_UNIT ?? DEFAULT_UNITS.ios,
  });
}

const APP_ADS_TEXT = `google.com, ${PUBLISHER_ID}, DIRECT, f08c47fec0942fa0\n`;

module.exports = { PUBLISHER_ID, DEFAULT_UNITS, validAdmobUnits, readAdmobUnits, APP_ADS_TEXT };
