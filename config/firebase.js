const { getMessaging } = require('firebase-admin/messaging');
// Firebase is already initialized in firebase-admin.js

module.exports = {
  // For Admin notifications — shows as a visible notification in the status bar
  sendPushNotification: async (token, title, body, data = {}) => {
    try {
      // Dedicated high-sound channels for order alerts (Android channel sound is immutable;
      // never reuse a channel that may have been created without sound).
      const channelId =
        data?.type === 'order_broadcast'
          ? 'rider_orders'
          : data?.type === 'seller_new_order'
            ? 'seller_orders'
            : 'default';

      const message = {
        token,
        notification: { title, body },
        data: { ...data, timestamp: String(Date.now()) },
        android: {
          priority: 'high',
          notification: {
            channelId,
            priority: 'high',
            sound: 'default',
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
      };
      await getMessaging().send(message);
      console.log('📱 FCM Push Sent to:', token, '| channel:', channelId);
    } catch (error) {
      console.error('❌ FCM Push Error:', error);
    }
  },

  // For Order broadcasts — data-only, HIGH priority for instant delivery even in Doze mode
  sendDataOnlyPush: async (token, data = {}) => {
    try {
      const message = {
        token,
        data: { ...data, timestamp: String(Date.now()) },
        android: {
          priority: 'high',        // FCM transport priority — bypasses Doze mode
          ttl: 0,                  // Time-to-live = 0: deliver NOW or not at all (no queuing delay)
          restrictedPackageName: undefined,
        },
        apns: {
          headers: {
            'apns-priority': '10', // iOS: highest priority (1=low, 5=normal, 10=high)
            'apns-push-type': 'background',
          },
          payload: {
            aps: {
              contentAvailable: true, // Wake up iOS app even in background
            },
          },
        },
      };
      await getMessaging().send(message);
      console.log('📱 FCM Data-Only Push Sent to:', token);
    } catch (error) {
      // Auto-clear stale/unregistered tokens from DB to prevent repeated failures
      if (
        error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token'
      ) {
        console.warn(`⚠️ Stale FCM token detected. Clearing from DB: ${token?.substring(0, 20)}...`);
        try {
          const Rider = require('../models/Rider');
          const Kitchen = require('../models/Kitchen');
          await Promise.all([
            Rider.updateOne({ expoPushToken: token }, { $unset: { expoPushToken: '' } }),
            Kitchen.updateOne({ expoPushToken: token }, { $unset: { expoPushToken: '' } }),
          ]);
        } catch (dbErr) {
          console.error('Failed to clear stale token from DB:', dbErr.message);
        }
      } else {
        console.error('❌ FCM Data Push Error:', error);
      }
    }
  },
};
