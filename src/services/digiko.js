/**
 * Digiko DEX Service
 * 
 * Integración con la API de Digiko para obtener precios de tokens
 * API: https://digiko.io/api/prices
 * 
 * Nota: A diferencia de Swopus, Digiko no expone pares con reservas,
 * solo precios de tokens. Los pares se infieren del campo derivedFrom.
 */

const axios = require('axios');

const DIGIKO_API_URL = process.env.DIGIKO_API_URL || 'https://digiko.io/api/prices';

/**
 * Fetch precios desde Digiko API
 * @returns {Object} { prices: {...}, updatedAt, network }
 */
async function fetchPrices() {
  try {
    const response = await axios.get(DIGIKO_API_URL, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'KleverDCA/1.0'
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('[DIGIKO] Error fetching prices:', error.message);
    throw error;
  }
}

/**
 * Parsear datos de tokens desde la respuesta de Digiko
 * @param {Object} data - Respuesta de la API
 * @returns {Array} Lista de tokens con precios
 */
function parseTokens(data) {
  if (!data || !data.prices) {
    return [];
  }
  
  return Object.entries(data.prices).map(([symbol, info]) => ({
    symbol: symbol,
    name: getTokenName(symbol),
    price_usd: info.priceUsd || 0,
    price_klv: info.priceKlv || 0,
    change_24h: info.priceChange24h || 0,
    pair_id: info.pairId || null,
    derived_from: info.derivedFrom || null,
    depth: info.depth || 0
  }));
}

/**
 * Obtener nombre legible del token
 */
function getTokenName(symbol) {
  const names = {
    'KLV': 'Klever',
    'KFI': 'Klever Finance',
    'USDT': 'Tether USD',
    'USDC': 'USD Coin',
    'DGKO': 'Digiko',
    'KID': 'KID Token',
    'SAVO': 'Savo',
    'DAXDO': 'Daxdo',
    'KUNAI': 'Kunai',
    'GOAT': 'Goat',
    'KAKA': 'Kaka',
    'WSOL': 'Wrapped SOL',
    'CTR': 'CTR Token',
    'PMD': 'PMD Token',
    'SHIT': 'Shit Token',
    'KONG': 'Kong',
    'BABYDGKO': 'Baby Digiko'
  };
  return names[symbol] || symbol;
}

/**
 * Generar pares de trading desde los datos de Digiko
 * Usa el campo derivedFrom para inferir los pares
 * 
 * @param {Object} data - Respuesta de Digiko API
 * @returns {Array} Lista de pares de trading
 */
function generateTradingPairs(data) {
  const pairs = [];
  
  if (!data || !data.prices) {
    return pairs;
  }
  
  const prices = data.prices;
  
  for (const [symbol, info] of Object.entries(prices)) {
    // Si el token tiene derivedFrom (y no es stablecoin), crear par
    if (info.derivedFrom && info.derivedFrom !== 'USD-peg' && prices[info.derivedFrom]) {
      const baseSymbol = info.derivedFrom;
      
      // Par: token -> base (ej: KFI -> KLV)
      pairs.push({
        token_from: symbol,
        token_to: baseSymbol,
        pair_id_external: info.pairId ? `digiko_${info.pairId}` : `digiko_${symbol}_${baseSymbol}`,
        // Digiko no expone reservas, usamos precio para calcular ratio
        // reserve0 / reserve1 = price
        reserve0: 1000000000, // 1000 tokens (6 decimales)
        reserve1: Math.floor((info.priceKlv || 1) * 1000000000)
      });
      
      // Par inverso: base -> token (ej: KLV -> KFI)
      pairs.push({
        token_from: baseSymbol,
        token_to: symbol,
        pair_id_external: info.pairId ? `digiko_${info.pairId}_inv` : `digiko_${baseSymbol}_${symbol}`,
        reserve0: Math.floor((info.priceKlv || 1) * 1000000000),
        reserve1: 1000000000
      });
    }
  }
  
  // Agregar pares principales con stablecoins
  const stables = ['USDT', 'USDC'];
  const mainTokens = ['KLV', 'KFI'];
  
  for (const stable of stables) {
    if (!prices[stable]) continue;
    
    for (const main of mainTokens) {
      if (!prices[main]) continue;
      
      const mainPrice = prices[main].priceUsd;
      const stablePrice = prices[stable].priceUsd || 1;
      const ratio = mainPrice / stablePrice;
      
      // Par: main -> stable
      pairs.push({
        token_from: main,
        token_to: stable,
        pair_id_external: `digiko_${main}_${stable}`,
        reserve0: 1000000000,
        reserve1: Math.floor(ratio * 1000000000)
      });
      
      // Par: stable -> main
      pairs.push({
        token_from: stable,
        token_to: main,
        pair_id_external: `digiko_${stable}_${main}`,
        reserve0: Math.floor(ratio * 1000000000),
        reserve1: 1000000000
      });
    }
  }
  
  return pairs;
}

/**
 * Construir URL del logo del token
 */
function buildLogoUrl(symbol) {
  return `https://raw.githubusercontent.com/klever-io/klever-assets/main/tokens/${symbol}/logo.png`;
}

/**
 * Filtrar pares válidos (todos son válidos en Digiko ya que no hay reservas reales)
 */
function filterValidPairs(pairs, minReserve = 0) {
  // Digiko no tiene reservas reales, todos los pares son "válidos"
  return pairs;
}

/**
 * Extraer símbolo de token (compatible con interfaz de swopus)
 */
function extractTokenSymbol(tokenId) {
  return tokenId; // En Digiko el tokenId ya es el símbolo
}

module.exports = {
  fetchPrices,
  parseTokens,
  generateTradingPairs,
  getTokenName,
  buildLogoUrl,
  filterValidPairs,
  extractTokenSymbol,
  DIGIKO_API_URL
};
