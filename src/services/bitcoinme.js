/**
 * Bitcoin.me DeFi API Client
 * Fetches tokens, pools and quotations from Bitcoin.me DEX on KleverChain
 *
 * API Docs: https://docs.defi.bitcoin.me/api/
 *
 * Endpoints used:
 *   GET  /tokens                → List all tokens with prices and icons
 *   GET  /pools                 → List all liquidity pools
 *   GET  /pools/{scAddress}     → Pool details (prices, volume, fees)
 *   POST /quotation             → Swap quotation between two tokens
 *   GET  /health                → API health check
 *
 * Designed as drop-in companion to swopus.js — same pattern, same DB schema.
 * The syncWorker can call both services and upsert into the same tables.
 */

const BITCOINME_API_URL = process.env.BITCOINME_API_URL || 'https://api.bitcoin.me';
const BITCOINME_TESTNET_URL = process.env.BITCOINME_TESTNET_URL || 'https://api.testnet.bitcoin.me';

// Use testnet if KLEVER_NETWORK env is set to 'testnet'
function getBaseUrl() {
  const network = process.env.KLEVER_NETWORK || 'mainnet';
  return network === 'testnet' ? BITCOINME_TESTNET_URL : BITCOINME_API_URL;
}

// ════════════════════════════════════════
// Health
// ════════════════════════════════════════

/**
 * Check API health
 * @returns {Promise<{status: string}>}
 */
async function healthCheck() {
  const response = await fetch(`${getBaseUrl()}/health`);
  if (!response.ok) throw new Error(`Bitcoin.me API health check failed: ${response.status}`);
  return response.json();
}

// ════════════════════════════════════════
// Tokens
// ════════════════════════════════════════

/**
 * Fetch all tokens available in pools
 * @returns {Promise<Array<{tokenInID, tokenInAbbr, iconURL, price, variationPercent, lastVolume}>>}
 */
async function fetchTokens() {
  const response = await fetch(`${getBaseUrl()}/tokens`);
  if (!response.ok) throw new Error(`Bitcoin.me API error (tokens): ${response.status}`);
  return response.json();
}

// ════════════════════════════════════════
// Pools
// ════════════════════════════════════════

/**
 * Fetch all liquidity pools
 * @returns {Promise<Array<{scAddress, name, value, apr, baseAssetId, quoteAssetId, baseIconUrl, quoteIconUrl, baseTotalStaked, quoteTotalStaked, ...}>>}
 */
async function fetchPools() {
  const response = await fetch(`${getBaseUrl()}/pools`);
  if (!response.ok) throw new Error(`Bitcoin.me API error (pools): ${response.status}`);
  return response.json();
}

/**
 * Fetch details for a specific pool
 * @param {string} scAddress - Smart contract address of the pool
 * @returns {Promise<Object>} Pool with prices, volume, fees
 */
async function fetchPoolDetails(scAddress) {
  const response = await fetch(`${getBaseUrl()}/pools/${scAddress}`);
  if (!response.ok) throw new Error(`Bitcoin.me API error (pool ${scAddress}): ${response.status}`);
  return response.json();
}

// ════════════════════════════════════════
// Quotation
// ════════════════════════════════════════

/**
 * Get swap quotation between two tokens
 * This is what the DCA worker would use to execute swaps.
 *
 * @param {number} amountIn - Input token amount (human-readable, e.g. 1000)
 * @param {string} tokenIn  - Input token asset ID (e.g. "KLV")
 * @param {string} tokenOut - Output token asset ID (e.g. "DVK-54H7t3")
 * @returns {Promise<{tokenIn, amountIn, amountInUsd, tokenOut, amountOut, amountOutUsd, tokenInPrice, tokenOutPrice, tokenInPriceUsd, tokenOutPriceUsd, tokenInPrecision, tokenOutPrecision}>}
 */
async function getQuotation(amountIn, tokenIn, tokenOut) {
  const response = await fetch(`${getBaseUrl()}/quotation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountIn, tokenIn, tokenOut })
  });
  if (!response.ok) throw new Error(`Bitcoin.me API error (quotation): ${response.status}`);
  return response.json();
}

// ════════════════════════════════════════
// Data transformation helpers
// (Map Bitcoin.me format → your DB schema)
// ════════════════════════════════════════

/**
 * Extract token symbol from KDA asset ID
 * Same logic as swopus.js — strips the KDA suffix
 * Examples: "KLV" → "KLV", "DVK-54H7t3" → "DVK", "KPNK-GH81" → "KPNK"
 */
function extractTokenSymbol(assetId) {
  if (!assetId) return null;
  return assetId.split('-')[0].toUpperCase();
}

/**
 * Transform Bitcoin.me token → your DB token format
 * Compatible with syncQueries.upsertToken()
 *
 * @param {Object} token - From GET /tokens
 * @returns {Object} Mapped to your `tokens` table schema
 */
function mapTokenToDb(token) {
  return {
    symbol:           extractTokenSymbol(token.tokenInID),
    name:             token.tokenInAbbr || extractTokenSymbol(token.tokenInID),
    contract_address: token.tokenInID,        // Full KDA ID (e.g. "DVK-54H7t3")
    decimals:         6,                       // KleverChain default; override per-token if needed
    logo_url:         token.iconURL || null,
    is_active:        true,
    is_stablecoin:    isStablecoin(token.tokenInID),
    // Extra fields for price reference (not in original schema, but useful)
    _price_usd:       parseFloat(token.price) || 0,
    _variation_pct:   token.variationPercent || 0,
    _last_volume:     token.lastVolume || '0',
  };
}

/**
 * Transform Bitcoin.me pool → your DB trading_pair format
 * Generates TWO entries (bidirectional) just like Swopus sync does.
 *
 * @param {Object} pool - From GET /pools
 * @param {number} gatewayId - Your gateways.id for "bitcoinme"
 * @returns {Array<Object>} Two trading pair objects (forward + reverse)
 */
function mapPoolToTradingPairs(pool, gatewayId) {
  const forward = {
    token_from_symbol: extractTokenSymbol(pool.baseAssetId),
    token_to_symbol:   extractTokenSymbol(pool.quoteAssetId),
    token_from_id:     null, // Resolved by sync worker via token lookup
    token_to_id:       null,
    gateway_id:        gatewayId,
    pair_id_external:  pool.scAddress,          // Smart contract address as external ID
    reserve0:          pool.baseTotalStaked,
    reserve1:          pool.quoteTotalStaked,
    is_active:         true,
    // Extra metadata
    _base_asset_id:    pool.baseAssetId,
    _quote_asset_id:   pool.quoteAssetId,
    _pool_value:       pool.value,
    _apr:              pool.apr,
  };

  const reverse = {
    token_from_symbol: extractTokenSymbol(pool.quoteAssetId),
    token_to_symbol:   extractTokenSymbol(pool.baseAssetId),
    token_from_id:     null,
    token_to_id:       null,
    gateway_id:        gatewayId,
    pair_id_external:  pool.scAddress + '_rev',  // Mark as reverse pair
    reserve0:          pool.quoteTotalStaked,
    reserve1:          pool.baseTotalStaked,
    is_active:         true,
    _base_asset_id:    pool.quoteAssetId,
    _quote_asset_id:   pool.baseAssetId,
    _pool_value:       pool.value,
    _apr:              pool.apr,
  };

  return [forward, reverse];
}

// ════════════════════════════════════════
// Utility helpers
// ════════════════════════════════════════

/**
 * Check if a token is a stablecoin based on its ID
 */
function isStablecoin(assetId) {
  if (!assetId) return false;
  const symbol = assetId.split('-')[0].toUpperCase();
  return ['USDT', 'USDC', 'BUSD', 'DAI'].includes(symbol);
}

/**
 * Calculate price from pool reserves
 * Same signature as swopus.calculatePrice for compatibility
 */
function calculatePrice(reserve0, reserve1, decimals0 = 6, decimals1 = 6) {
  const r0 = parseFloat(reserve0);
  const r1 = parseFloat(reserve1);
  if (r0 === 0 || r1 === 0) return 0;
  const decimalAdjust = Math.pow(10, decimals1 - decimals0);
  return (r1 / r0) * decimalAdjust;
}

/**
 * Filter pools with valid liquidity
 * Same pattern as swopus.filterValidPairs
 */
function filterValidPools(pools, minReserve = 1000000) {
  return pools.filter(pool => {
    const r0 = parseFloat(pool.baseTotalStaked || 0);
    const r1 = parseFloat(pool.quoteTotalStaked || 0);
    return r0 >= minReserve && r1 >= minReserve;
  });
}

/**
 * Get icon URL — Bitcoin.me returns full URLs, no processing needed
 * Included for API parity with swopus.buildLogoUrl
 */
function buildLogoUrl(iconUrl) {
  return iconUrl || null;
}

/**
 * Fetch everything needed for a full sync in one go
 * Convenience method for the sync worker
 *
 * @returns {Promise<{tokens: Array, pools: Array}>}
 */
async function fetchAll() {
  const [tokens, pools] = await Promise.all([
    fetchTokens(),
    fetchPools()
  ]);
  return { tokens, pools };
}

module.exports = {
  // Core API calls
  healthCheck,
  fetchTokens,
  fetchPools,
  fetchPoolDetails,
  getQuotation,
  fetchAll,

  // Data mapping (Bitcoin.me → your DB)
  mapTokenToDb,
  mapPoolToTradingPairs,

  // Utilities (compatible with swopus.js)
  extractTokenSymbol,
  calculatePrice,
  filterValidPools,
  buildLogoUrl,
  isStablecoin,

  // Config
  BITCOINME_API_URL,
  BITCOINME_TESTNET_URL,
  getBaseUrl
};
