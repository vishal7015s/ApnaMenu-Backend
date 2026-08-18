#!/bin/bash
# ============================================
# ApnaMenu — Redis setup on AWS EC2 (free tier)
# Run on your EC2 instance: bash scripts/setup-redis-ec2.sh
# ============================================
set -e

REDIS_PASSWORD="${REDIS_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)}"

echo "==> Installing Redis..."
sudo apt-get update -qq
sudo apt-get install -y redis-server

CONF="/etc/redis/redis.conf"
echo "==> Configuring Redis (localhost only, maxmemory 150mb)..."

sudo sed -i 's/^# maxmemory .*/maxmemory 150mb/' "$CONF" 2>/dev/null || true
sudo sed -i 's/^maxmemory .*/maxmemory 150mb/' "$CONF" 2>/dev/null || echo "maxmemory 150mb" | sudo tee -a "$CONF"
sudo sed -i 's/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/' "$CONF" 2>/dev/null || true
sudo sed -i 's/^maxmemory-policy .*/maxmemory-policy allkeys-lru/' "$CONF" 2>/dev/null || echo "maxmemory-policy allkeys-lru" | sudo tee -a "$CONF"
sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' "$CONF"
sudo sed -i 's/^# requirepass .*/requirepass '"$REDIS_PASSWORD"'/' "$CONF" 2>/dev/null || true
grep -q '^requirepass ' "$CONF" || echo "requirepass $REDIS_PASSWORD" | sudo tee -a "$CONF"

sudo systemctl enable redis-server
sudo systemctl restart redis-server

echo ""
echo "============================================"
echo "Redis installed successfully!"
echo ""
echo "Add this to your backend .env on EC2:"
echo "REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379"
echo ""
echo "Verify: redis-cli -a '$REDIS_PASSWORD' ping"
echo "============================================"
