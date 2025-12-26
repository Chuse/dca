/**
 * Sync Queries - Database operations for sync worker
 */

/**
 * Upsert a token (insert or update if exists)
 */
async function upsertToken(pool, tokenData) {
  const { symbol, name, logo_url, decimals, contract_address } = tokenData;
  
  const result = await pool.query(
    `INSERT INTO tokens (symbol, name, logo_url, decimals, contract_address, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (contract_address) 
     DO UPDATE SET 
       logo_url = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
       decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
       is_active = true
     RETURNING id, symbol`,
    [symbol, name || symbol, logo_url, decimals || 6, contract_address || symbol]
  );
  
  return result.rows[0];
}

/**
 * Get token by symbol
 */
async function getTokenBySymbol(pool, symbol) {
  const result = await pool.query(
    'SELECT id, symbol, decimals FROM tokens WHERE UPPER(symbol) = UPPER($1)',
    [symbol]
  );
  return result.rows[0] || null;
}

/**
 * Get gateway by slug
 */
async function getGatewayBySlug(pool, slug) {
  const result = await pool.query(
    'SELECT id, name, slug FROM gateways WHERE slug = $1',
    [slug]
  );
  return result.rows[0] || null;
}

/**
 * Upsert a trading pair with reserves
 */
async function upsertTradingPair(pool, pairData) {
  const { 
    token_from_id, 
    token_to_id, 
    gateway_id, 
    pair_id_external,
    reserve0, 
    reserve1 
  } = pairData;
  
  const result = await pool.query(
    `INSERT INTO trading_pairs 
     (token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, is_active, last_sync_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
     ON CONFLICT (token_from_id, token_to_id, gateway_id) 
     DO UPDATE SET 
       reserve0 = EXCLUDED.reserve0,
       reserve1 = EXCLUDED.reserve1,
       is_active = true,
       last_sync_at = NOW(),
       pair_id_external = COALESCE(EXCLUDED.pair_id_external, trading_pairs.pair_id_external)
     RETURNING id`,
    [token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1]
  );
  
  return result.rows[0];
}

/**
 * Deactivate pairs that weren't updated in this sync
 */
async function deactivateStalePairs(pool, gatewayId, updatedPairIds) {
  if (updatedPairIds.length === 0) return { count: 0 };
  
  const result = await pool.query(
    `UPDATE trading_pairs 
     SET is_active = false 
     WHERE gateway_id = $1 
       AND id != ALL($2::int[])
       AND is_active = true
     RETURNING id`,
    [gatewayId, updatedPairIds]
  );
  
  return { count: result.rowCount, ids: result.rows.map(r => r.id) };
}

/**
 * Get best price for a token pair across all gateways
 */
async function getBestPriceForPair(pool, tokenFromSymbol, tokenToSymbol) {
  const result = await pool.query(
    `SELECT 
       tp.id,
       g.name as gateway_name,
       g.fee_percentage,
       tp.reserve0,
       tp.reserve1,
       tf.decimals as from_decimals,
       tt.decimals as to_decimals,
       CASE WHEN tp.reserve1 > 0 
         THEN (tp.reserve0::numeric / tp.reserve1::numeric) 
         ELSE 0 
       END as price
     FROM trading_pairs tp
     JOIN tokens tf ON tp.token_from_id = tf.id
     JOIN tokens tt ON tp.token_to_id = tt.id
     JOIN gateways g ON tp.gateway_id = g.id
     WHERE UPPER(tf.symbol) = UPPER($1)
       AND UPPER(tt.symbol) = UPPER($2)
       AND tp.is_active = true
       AND g.is_active = true
     ORDER BY price ASC
     LIMIT 1`,
    [tokenFromSymbol, tokenToSymbol]
  );
  
  return result.rows[0] || null;
}

/**
 * Get sync statistics
 */
async function getSyncStats(pool, gatewayId) {
  const result = await pool.query(
    `SELECT 
       COUNT(*) FILTER (WHERE is_active = true) as active_pairs,
       COUNT(*) FILTER (WHERE is_active = false) as inactive_pairs,
       MAX(last_sync_at) as last_sync
     FROM trading_pairs
     WHERE gateway_id = $1`,
    [gatewayId]
  );
  
  return result.rows[0];
}

module.exports = {
  upsertToken,
  getTokenBySymbol,
  getGatewayBySlug,
  upsertTradingPair,
  deactivateStalePairs,
  getBestPriceForPair,
  getSyncStats
};
