/**
 * Generates a unique order ID (e.g., AM-2042)
 * @returns {string} Order ID
 */
const generateOrderId = () => {
  const timestampPart = Date.now().toString().slice(-5);
  const randomPart = Math.floor(10 + Math.random() * 90);
  return `AM-${timestampPart}${randomPart}`;
};

module.exports = { generateOrderId };
