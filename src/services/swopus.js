/**
 * Swopus DEX API Client
 * Fetches trading pairs and liquidity data from Swopus DEX
 */

const SWOPUS_API_URL = process.env.SWOPUS_API_URL || 'https://api3.swopus.com';

/**
 * Fetch all pairs from Swopus API
 * @returns {Promise<{tokens: Object, pairs: Array}>}
 */
async function fetchPairs() {
  const response = await fetch(`${SWOPUS_API_URL}/pairs`);
  
  if (!response.ok) {
    throw new Error(`Swopus API error: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Extract token symbol from Swopus token ID
 * Examples: "KLV" -> "KLV", "KFI" -> "KFI", "DVK-1AB2" -> "DVK"
 */
function extractTokenSymbol(tokenId) {
  if (!tokenId) return null;
  // Remove any suffix after hyphen (for KDA-style tokens)
  return tokenId.split('-')[0].toUpperCase();
}

/**
 * Calculate price from reserves
 * @param {string} reserve0 - Reserve of token0 (what you pay)
 * @param {string} reserve1 - Reserve of token1 (what you receive)
 * @param {number} decimals0 - Decimals of token0
 * @param {number} decimals1 - Decimals of token1
 * @returns {number} Price (how much token1 you get for 1 token0)
 */
function calculatePrice(reserve0, reserve1, decimals0 = 6, decimals1 = 6) {
  const r0 = parseFloat(reserve0);
  const r1 = parseFloat(reserve1);
  
  if (r0 === 0 || r1 === 0) return 0;
  
  // Adjust for decimals difference
  const decimalAdjust = Math.pow(10, decimals1 - decimals0);
  return (r1 / r0) * decimalAdjust;
}

/**
 * Filter pairs with valid liquidity
 * @param {Array} pairs - Raw pairs from API
 * @param {number} minReserve - Minimum reserve to consider valid
 * @returns {Array} Filtered pairs
 */
function filterValidPairs(pairs, minReserve = 1000000) {
  return pairs.filter(pair => {
    const r0 = parseFloat(pair.reserve0 || 0);
    const r1 = parseFloat(pair.reserve1 || 0);
    return r0 >= minReserve && r1 >= minReserve;
  });
}

/**
 * Build logo URL from Swopus proxy path
 * @param {string} logoPath - e.g., "/token-logos/KLV?size=128"
 * @returns {string} Full URL
 */
function buildLogoUrl(logoPath) {
  if (!logoPath) return null;
  if (logoPath.startsWith('http')) return logoPath;
  return `${SWOPUS_API_URL}${logoPath}`;
}

module.exports = {
  fetchPairs,
  extractTokenSymbol,
  calculatePrice,
  filterValidPairs,
  buildLogoUrl,
  SWOPUS_API_URL
};

