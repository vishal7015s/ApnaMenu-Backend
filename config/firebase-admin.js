const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const serviceAccount = require('./firebase-service-account.json');

let app;
try {
  app = initializeApp({
    credential: cert(serviceAccount)
  });
  console.log('🔥 Firebase Admin SDK Initialized Successfully');
} catch (error) {
  console.error('Firebase admin initialization error:', error.stack);
}

module.exports = {
  auth: () => getAuth(app)
};
