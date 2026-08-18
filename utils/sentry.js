let Sentry = null;
let initialized = false;

function initSentry() {
  if (initialized || !process.env.SENTRY_DSN) return;
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    });
    initialized = true;
  } catch (err) {
    console.warn('[sentry] init skipped:', err.message);
  }
}

function captureException(err, context) {
  if (Sentry && initialized) {
    Sentry.captureException(err, { extra: context });
  }
}

module.exports = { initSentry, captureException };
