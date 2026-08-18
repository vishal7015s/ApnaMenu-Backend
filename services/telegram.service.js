// ====================================
// Telegram Bot Alert Service
// ====================================

const axios = require('axios');

/**
 * Send an alert message to the Admin Telegram Group
 * @param {string} message 
 */
const sendTelegramAlert = async (message) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.warn('⚠️ Telegram config missing. Alert not sent:', message);
      return;
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
    
    console.log('✅ Telegram alert sent');
  } catch (error) {
    console.error('❌ Failed to send Telegram alert:', error.message);
  }
};

module.exports = { sendTelegramAlert };
