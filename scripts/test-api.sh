#!/bin/bash

# CartWhisper AI Backend API Test Script
# Usage: ./scripts/test-api.sh

BASE_URL="${BASE_URL:-https://cartwhisperaibackend-production.up.railway.app}"
API_KEY="${API_KEY:-cw_test_key_12345}"

echo "========================================"
echo "CartWhisper AI Backend API Test"
echo "========================================"
echo "Base URL: $BASE_URL"
echo "API Key: $API_KEY"
echo ""

# Color output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo -e "${YELLOW}[Test 1] Health Check${NC}"
HEALTH_RESPONSE=$(curl -s "$BASE_URL/api/health")
echo "Response: $HEALTH_RESPONSE"
if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
fi
echo ""

# Test 2: Sync Products (without API key - should fail)
echo -e "${YELLOW}[Test 2] Sync Products (no API key - expect 401)${NC}"
SYNC_NO_KEY=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/products/sync" \
    -H "Content-Type: application/json" \
    -d '{"products":[]}')
HTTP_CODE=$(echo "$SYNC_NO_KEY" | tail -1)
if [ "$HTTP_CODE" = "401" ]; then
    echo -e "${GREEN}✓ Correctly rejected without API key (401)${NC}"
else
    echo -e "${RED}✗ Expected 401, got $HTTP_CODE${NC}"
fi
echo ""

# Test 3: Sync Products (with API key)
echo -e "${YELLOW}[Test 3] Sync Products (with API key)${NC}"
SYNC_RESPONSE=$(curl -s -X POST "$BASE_URL/api/products/sync" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{
        "products": [
            {
                "id": "gid://shopify/Product/1001",
                "handle": "榴莲千层蛋糕",
                "title": "榴莲千层蛋糕",
                "description": "新鲜榴莲制作的千层蛋糕",
                "productType": "蛋糕",
                "vendor": "榴莲甜品屋",
                "price": "128.00",
                "image": {"url": "https://example.com/cake1.jpg"},
                "tags": ["榴莲", "蛋糕", "甜品"]
            },
            {
                "id": "gid://shopify/Product/1002",
                "handle": "榴莲冰淇淋",
                "title": "榴莲冰淇淋",
                "description": "纯榴莲果肉制作的冰淇淋",
                "productType": "冰淇淋",
                "vendor": "榴莲甜品屋",
                "price": "38.00",
                "image": {"url": "https://example.com/ice1.jpg"},
                "tags": ["榴莲", "冰淇淋", "冷饮"]
            },
            {
                "id": "gid://shopify/Product/1003",
                "handle": "榴莲泡芙",
                "title": "榴莲泡芙",
                "description": "酥脆外皮配榴莲奶油",
                "productType": "蛋糕",
                "vendor": "榴莲甜品屋",
                "price": "58.00",
                "image": {"url": "https://example.com/puff1.jpg"},
                "tags": ["榴莲", "泡芙", "甜品"]
            },
            {
                "id": "gid://shopify/Product/1004",
                "handle": "芒果千层蛋糕",
                "title": "芒果千层蛋糕",
                "description": "新鲜芒果制作的千层蛋糕",
                "productType": "蛋糕",
                "vendor": "榴莲甜品屋",
                "price": "98.00",
                "image": {"url": "https://example.com/mango1.jpg"},
                "tags": ["芒果", "蛋糕", "甜品"]
            }
        ]
    }')
echo "Response: $SYNC_RESPONSE"
if echo "$SYNC_RESPONSE" | grep -q '"success":true'; then
    echo -e "${GREEN}✓ Product sync successful${NC}"
elif echo "$SYNC_RESPONSE" | grep -q '"error":"Invalid API key"'; then
    echo -e "${YELLOW}⚠ API key not configured in database yet${NC}"
else
    echo -e "${RED}✗ Product sync failed${NC}"
fi
echo ""

# Test 4: Get Recommendations
echo -e "${YELLOW}[Test 4] Get Recommendations${NC}"
REC_RESPONSE=$(curl -s "$BASE_URL/api/recommendations/1001" \
    -H "X-API-Key: $API_KEY")
echo "Response: $REC_RESPONSE"
if echo "$REC_RESPONSE" | grep -q '"recommendations"'; then
    echo -e "${GREEN}✓ Get recommendations successful${NC}"
elif echo "$REC_RESPONSE" | grep -q '"error":"Invalid API key"'; then
    echo -e "${YELLOW}⚠ API key not configured in database yet${NC}"
else
    echo -e "${RED}✗ Get recommendations failed${NC}"
fi
echo ""

# Test 5: Get Recommendations with limit
echo -e "${YELLOW}[Test 5] Get Recommendations (limit=2)${NC}"
REC_LIMIT_RESPONSE=$(curl -s "$BASE_URL/api/recommendations/1001?limit=2" \
    -H "X-API-Key: $API_KEY")
echo "Response: $REC_LIMIT_RESPONSE"
echo ""

echo "========================================"
echo "Test Complete"
echo "========================================"
