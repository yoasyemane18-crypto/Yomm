/**
 * Yeme Bingo — Firebase Cloud Functions (2nd Gen) Push Dispatcher
 *
 * Handles:
 *  1. `onNotificationQueued` (RTDB `onValueCreated` on `/notificationQueue/{notifId}`):
 *     Reads active FCM tokens from `/pushTokens/{userKey}/{tokenId}`, respects each user's
 *     opt-in preferences (`roundAlerts`, `promos`, `winAlerts`) and topic subscriptions,
 *     localizes payload into Amharic (`am`) or English (`en`) matching their header language
 *     switcher, sends batches of 500 via FCM HTTP v1 (`getMessaging().sendEachForMulticast`),
 *     attaches deep-link `data.screen`, and removes invalid/expired tokens automatically.
 *
 *  2. `onWalletCreditApproved` (RTDB `onValueUpdated` on `/pays/{payId}`):
 *     Automatically dispatches a localized Amharic/English wallet credit alert when a user's
 *     deposit request changes from `pending` -> `approved`.
 *
 *  3. `sendTelegramAlert(...)`:
 *     Optional Telegram Bot (`sendMessage`) broadcaster for channels/groups when
 *     `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID` are set in `functions/.env`.
 *
 *  4. Firestore Trigger Template (`onFirestoreNotificationQueued`):
 *     Included cleanly below if you migrate/mirror `notificationQueue/{notifId}` to Firestore.
 *
 * DEPLOYMENT:
 *   cd functions && npm install
 *   cp .env.example .env   # fill optional Telegram keys & APP_BASE_URL
 *   firebase use wow-878fc
 *   firebase deploy --only functions
 */

const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp({
  databaseURL:
    process.env.FIREBASE_DATABASE_URL || 'https://wow-878fc-default-rtdb.firebaseio.com'
});

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://wow-878fc.web.app').replace(/\/$/, '');
const ANDROID_CHANNEL_ID = process.env.ANDROID_CHANNEL_ID || 'yeme_bingo_alerts';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/mismatched-credential'
]);

const TOPIC_TO_PREF = {
  all: null,
  fast_bingo: 'roundAlerts',
  classic_bingo: 'roundAlerts',
  keno: 'roundAlerts',
  promos: 'promos',
  lucky_coins: 'promos',
  ludo: 'promos',
  hi_lo: 'promos',
  crazy_8: 'promos',
  buna_time: 'promos',
  win_alerts: 'winAlerts'
};

/**
 * Pick Amharic (`am`) or English (`en`) copy based on user's saved language & composer mode.
 */
function pickLocalizedCopy(job, userLang) {
  const mode = job.langMode || 'auto'; // 'auto' | 'en' | 'am'
  const effectiveLang = mode === 'am' ? 'am' : mode === 'en' ? 'en' : userLang === 'am' ? 'am' : 'en';
  const copy = (job.copy && job.copy[effectiveLang]) || (job.copy && job.copy.en) || {};
  return {
    lang: effectiveLang,
    title: String(copy.title || job.title || 'Yeme Bingo').slice(0, 120),
    body: String(copy.body || job.body || '').slice(0, 320)
  };
}

/**
 * Determine whether a token record should receive this notification.
 */
function matchesAudience(rec, job) {
  if (!rec || rec.active === false || !rec.token) return false;
  if (job.targetUser && rec.user && rec.user.toLowerCase() !== String(job.targetUser).toLowerCase()) {
    return false;
  }
  const prefs = rec.prefs || {};
  const topic = job.topic || 'all';
  const prefKey = Object.prototype.hasOwnProperty.call(TOPIC_TO_PREF, topic)
    ? TOPIC_TO_PREF[topic]
    : 'promos';

  if (prefKey && prefs[prefKey] === false) return false;
  if (topic === 'all') {
    // Respect total opt-out if all three categories are disabled
    if (prefs.roundAlerts === false && prefs.promos === false && prefs.winAlerts === false) {
      return false;
    }
    return true;
  }
  const topics = rec.topics || {};
  if (Object.keys(topics).length > 0 && topics[topic] === false) return false;
  return true;
}

/**
 * Optional Telegram Bot `sendMessage` helper.
 */
async function sendTelegramAlert(job) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { skipped: true, reason: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' };

  const en = (job.copy && job.copy.en) || {};
  const am = (job.copy && job.copy.am) || {};
  const screen = job.screen || 'home';
  const deepUrl = `${APP_BASE_URL}/?screen=${encodeURIComponent(screen)}`;
  const text = [
    `*${en.title || 'Yeme Bingo'}*`,
    en.body || '',
    am.title ? `\n*${am.title}*` : '',
    am.body || '',
    `\n▶ [Open ${screen}](${deepUrl})`
  ]
    .filter(Boolean)
    .join('\n');

  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    })
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) {
    logger.warn('Telegram sendMessage failed', json);
    return { ok: false, error: json.description || resp.statusText };
  }
  return { ok: true, messageId: json.result && json.result.message_id };
}

/**
 * Core FCM HTTP v1 multicast dispatcher with 500-token chunking & invalid token cleanup.
 */
async function dispatchPushJob(notifId, job) {
  const db = getDatabase();
  const messaging = getMessaging();
  const screen = String(job.screen || 'home');
  const snap = await db.ref('pushTokens').once('value');
  const allUsers = snap.val() || {};

  // Deduplicate by token and group into language buckets (`am` / `en`)
  const buckets = { am: [], en: [] };
  const seenTokens = new Set();

  Object.keys(allUsers).forEach((userKey) => {
    const userTokens = allUsers[userKey] || {};
    Object.keys(userTokens).forEach((tokenKey) => {
      const rec = userTokens[tokenKey];
      if (!matchesAudience(rec, job)) return;
      // Only dispatch via FCM for real Web/Native FCM tokens (skip local WebView fallback IDs)
      if (!rec.isFcm || seenTokens.has(rec.token)) return;
      seenTokens.add(rec.token);

      const userLang = rec.lang === 'am' || rec.locale === 'ti' ? 'am' : 'en';
      const targetLang = job.langMode === 'am' ? 'am' : job.langMode === 'en' ? 'en' : userLang;
      buckets[targetLang].push({
        token: rec.token,
        path: `pushTokens/${userKey}/${tokenKey}`
      });
    });
  });

  let sentCount = 0;
  let failedCount = 0;
  const cleanupPaths = [];

  for (const langKey of ['en', 'am']) {
    const list = buckets[langKey];
    if (!list.length) continue;

    const localized = pickLocalizedCopy(job, langKey);
    const clickLink = `${APP_BASE_URL}/?screen=${encodeURIComponent(screen)}`;

    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const message = {
        tokens: chunk.map((x) => x.token),
        notification: {
          title: localized.title,
          body: localized.body
        },
        data: {
          notifId: String(notifId),
          screen,
          lang: localized.lang,
          topic: String(job.topic || 'all'),
          title: localized.title,
          body: localized.body,
          click_action: clickLink
        },
        android: {
          priority: 'high',
          notification: {
            channelId: ANDROID_CHANNEL_ID,
            color: '#6D28D9',
            tag: `yeme_${screen}`,
            clickAction: 'FLUTTER_NOTIFICATION_CLICK'
          }
        },
        webpush: {
          headers: { Urgency: 'high' },
          notification: {
            title: localized.title,
            body: localized.body,
            icon: `${APP_BASE_URL}/public/icon-192.png`,
            badge: `${APP_BASE_URL}/public/badge-72.png`,
            tag: `yeme_${screen}`
          },
          fcmOptions: {
            link: clickLink
          }
        }
      };

      const batchResp = await messaging.sendEachForMulticast(message);
      sentCount += batchResp.successCount;
      failedCount += batchResp.failureCount;

      batchResp.responses.forEach((r, idx) => {
        if (!r.success && r.error && INVALID_TOKEN_CODES.has(r.error.code)) {
          cleanupPaths.push(chunk[idx].path);
        }
      });
    }
  }

  // Prune expired / unregistered FCM tokens
  if (cleanupPaths.length) {
    const removals = {};
    cleanupPaths.forEach((p) => {
      removals[p] = null;
    });
    await db.ref().update(removals);
  }

  const telegramResult = job.telegramMirror ? await sendTelegramAlert(job) : { skipped: true };

  return {
    status: 'sent',
    sentCount,
    failedCount,
    cleanedTokens: cleanupPaths.length,
    telegramResult,
    processedAt: Date.now()
  };
}

/**
 * 2nd Gen RTDB Trigger: listens to `/notificationQueue/{notifId}` created from Admin Studio
 * or automated game/wallet events.
 */
exports.onNotificationQueued = onValueCreated(
  {
    ref: '/notificationQueue/{notifId}',
    region: 'us-central1'
  },
  async (event) => {
    const notifId = event.params.notifId;
    const job = event.data.val();
    if (!job || job.status === 'sent') return null;

    try {
      const result = await dispatchPushJob(notifId, job);
      await event.data.ref.update(result);
      logger.info('Processed notificationQueue item', { notifId, ...result });
      return result;
    } catch (err) {
      logger.error('Failed notificationQueue dispatch', { notifId, error: err.message });
      await event.data.ref.update({
        status: 'error',
        error: err.message,
        processedAt: Date.now()
      });
      return null;
    }
  }
);

/**
 * 2nd Gen Automated Wallet Credit Trigger:
 * Sends localized Win / Wallet Credit alert when an admin approves a deposit in `/pays/{payId}`.
 */
exports.onWalletCreditApproved = onValueUpdated(
  {
    ref: '/pays/{payId}',
    region: 'us-central1'
  },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    if (!before || !after) return null;
    if (before.st === 'pending' && after.st === 'approved' && after.u && after.amt > 0) {
      const db = getDatabase();
      const qId = `credit_${event.params.payId}`;
      await db.ref(`notificationQueue/${qId}`).set({
        id: qId,
        template: 'win_credit',
        topic: 'win_alerts',
        screen: 'wallet',
        langMode: 'auto',
        targetUser: after.u,
        copy: {
          en: {
            title: '💰 Wallet Credited · +' + after.amt + ' ETB',
            body: after.amt + ' ETB has been added to your Yeme Bingo wallet. Good luck at the tables!'
          },
          am: {
            title: '💰 ቦርሳዎ ተሞልቷል · +' + after.amt + ' ብር',
            body: after.amt + ' ብር ወደ የሜ ቢንጎ ቦርሳዎ ገብቷል። መልካም ዕድል!'
          }
        },
        createdAt: Date.now(),
        status: 'queued'
      });
    }
    return null;
  }
);

/**
 * Optional Firestore 2nd Gen Trigger (if mirroring `notificationQueue/{notifId}` to Firestore).
 * Uses the exact same FCM HTTP v1 dispatcher & invalid token cleanup.
 */
exports.onFirestoreNotificationQueued = onDocumentCreated(
  {
    document: 'notificationQueue/{notifId}',
    region: 'us-central1'
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const job = snap.data();
    if (!job || job.status === 'sent') return null;

    try {
      const result = await dispatchPushJob(event.params.notifId, job);
      await snap.ref.set(result, { merge: true });
      return result;
    } catch (err) {
      logger.error('Firestore trigger dispatch error', { notifId: event.params.notifId, error: err.message });
      await snap.ref.set({ status: 'error', error: err.message, processedAt: Date.now() }, { merge: true });
      return null;
    }
  }
);
