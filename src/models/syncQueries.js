/**
 * Sync Queries - Database operations for sync worker
 * Respeta admin_disabled en todas las operaciones
 */

/**
 * Upsert a token (respeta admin_disabled)
 */
async function upsertToken(pool, tokenData) {
  const { symbol, name, logo_url, decimals, contract_address } = tokenData;
  
  // Primero verificar si existe y está deshabilitado por admin
  const existing = await pool.query(
    'SELECT id, admin_disabled FROM tokens WHERE contract_address = $1',
    [contract_address || symbol]
  );
  
  if (existing.rows.length > 0 && existing.rows[0].admin_disabled) {
    // No modificar tokens deshabilitados por admin
    return { id: existing.rows[0].id, symbol, skipped: true };
  }
  
  const result = await pool.query(
    `INSERT INTO tokens (symbol, name, logo_url, decimals, contract_address, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (contract_address) 
     DO UPDATE SET 
       logo_url = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
       decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
       is_active = CASE WHEN tokens.admin_disabled THEN tokens.is_active ELSE true END
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
    'SELECT id, symbol, decimals, admin_disabled FROM tokens WHERE UPPER(symbol) = UPPER($1)',
    [symbol]
  );
  return result.rows[0] || null;
}

/**
 * Get gateway by slug
 */
async function getGatewayBySlug(pool, slug) {
  const result = await pool.query(
    'SELECT id, name, slug, admin_disabled FROM gateways WHERE slug = $1',
    [slug]
  );
  return result.rows[0] || null;
}

/**
 * Upsert trading pair respetando admin_disabled
 */
async function upsertTradingPairRespectingAdmin(pool, pairData) {
  const { 
    token_from_id, 
    token_to_id, 
    gateway_id, 
    pair_id_external,
    reserve0, 
    reserve1 
  } = pairData;
  
  // Verificar si el par existe y está deshabilitado por admin
  const existing = await pool.query(
    `SELECT id, admin_disabled FROM trading_pairs 
     WHERE token_from_id = $1 AND token_to_id = $2 AND gateway_id = $3`,
    [token_from_id, token_to_id, gateway_id]
  );
  
  if (existing.rows.length > 0 && existing.rows[0].admin_disabled) {
    // Solo actualizar reserves, no tocar is_active
    await pool.query(
      `UPDATE trading_pairs SET 
         reserve0 = $1, reserve1 = $2, last_sync_at = NOW(), pair_id_external = $3
       WHERE id = $4`,
      [reserve0, reserve1, pair_id_external, existing.rows[0].id]
    );
    return { id: existing.rows[0].id, skipped: true };
  }
  
  // Upsert normal
  const result = await pool.query(
    `INSERT INTO trading_pairs 
     (token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, is_active, last_sync_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
     ON CONFLICT (token_from_id, token_to_id, gateway_id) 
     DO UPDATE SET 
       reserve0 = EXCLUDED.reserve0,
       reserve1 = EXCLUDED.reserve1,
       is_active = CASE WHEN trading_pairs.admin_disabled THEN trading_pairs.is_active ELSE true END,
       last_sync_at = NOW(),
       pair_id_external = COALESCE(EXCLUDED.pair_id_external, trading_pairs.pair_id_external)
     RETURNING id`,
    [token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1]
  );
  
  return { id: result.rows[0].id, skipped: false };
}

/**
 * Upsert trading pair (versión simple para compatibilidad)
 */
async function upsertTradingPair(pool, pairData) {
  return upsertTradingPairRespectingAdmin(pool, pairData);
}

/**
 * Desactivar pares que no están en el sync (respetando admin_disabled)
 */
async function deactivateStalePairsRespectingAdmin(pool, gatewayId, updatedPairIds) {
  if (updatedPairIds.length === 0) return { count: 0 };
  
  // Solo desactivar pares que NO están deshabilitados por admin
  const result = await pool.query(
    `UPDATE trading_pairs 
     SET is_active = false 
     WHERE gateway_id = $1 
       AND id != ALL($2::int[])
       AND is_active = true
       AND admin_disabled = false
     RETURNING id`,
    [gatewayId, updatedPairIds]
  );
  
  return { count: result.rowCount, ids: result.rows.map(r => r.id) };
}

/**
 * Versión simple para compatibilidad
 */
async function deactivateStalePairs(pool, gatewayId, updatedPairIds) {
  return deactivateStalePairsRespectingAdmin(pool, gatewayId, updatedPairIds);
}

/**
 * Get best price for a token pair
 */
async function getBestPriceForPair(pool, tokenFromSymbol, tokenToSymbol) {
  const result = await pool.query(
    `SELECT 
       tp.id,
       g.name as gateway_name,
       g.fee_percentage,
       tp.reserve0,
       tp.reserve1,
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
       AND tp.admin_disabled = false
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
       COUNT(*) FILTER (WHERE admin_disabled = true) as admin_disabled_pairs,
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
  upsertTradingPairRespectingAdmin,
  deactivateStalePairs,
  deactivateStalePairsRespectingAdmin,
  getBestPriceForPair,
  getSyncStats
};
