'use strict';

const RENTAL_MS = 3 * 86400000;
const EMOJI_PRICE = 1000;
const EMOJI_AD_VIEWS = 2;
const AD_REWARDS = Object.freeze([200, 250, 300, 350, 400]);
const rows = [
  ['bunny_face', '🐰', 'Tavşan', 'rabbit'],
  ['bunny_hop', '🐇', 'Zıp Zıp', 'rabbit'],
  ['bunny_carrot', '🥕', 'Havuç', 'rabbit'],
  ['bunny_love', '🐰💛', 'Sevgi Tavşanı', 'rabbit'],
  ['bunny_party', '🐰🎉', 'Parti Tavşanı', 'rabbit'],
  ['bunny_sleep', '🐰💤', 'Uykucu Tavşan', 'rabbit'],
  ['love_heart', '❤️', 'Kalp', 'love'],
  ['love_sparkle', '💖', 'Işıltılı Kalp', 'love'],
  ['love_kiss', '😘', 'Öpücük', 'love'],
  ['love_eyes', '😍', 'Hayranlık', 'love'],
  ['love_hug', '🫶', 'Sevgi', 'love'],
  ['love_rose', '🌹', 'Gül', 'love'],
  ['fun_laugh', '😂', 'Kahkaha', 'fun'],
  ['fun_cool', '😎', 'Havalı', 'fun'],
  ['fun_clap', '👏', 'Alkış', 'fun'],
  ['fun_fire', '🔥', 'Alev', 'fun'],
  ['fun_tea', '🫖', 'Çay Vakti', 'fun'],
  ['fun_luck', '🍀', 'Bol Şans', 'fun'],
  ['fun_trophy', '🏆', 'Kupa', 'fun'],
  ['fun_think', '🤔', 'Düşünüyorum', 'fun'],
];
const EMOJIS = Object.freeze(rows.map(([id, glyph, name, category]) => Object.freeze({
  id, glyph, name, category, priceCarrots: EMOJI_PRICE,
  durationSeconds: RENTAL_MS / 1000, adViewsRequired: EMOJI_AD_VIEWS,
})));
const emojiById = (id) => EMOJIS.find((emoji) => emoji.id === id);
module.exports = { EMOJIS, emojiById, RENTAL_MS, EMOJI_PRICE, EMOJI_AD_VIEWS, AD_REWARDS };
