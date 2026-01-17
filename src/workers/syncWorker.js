/**
 * Sync Worker - Sincroniza pares de trading desde múltiples DEX
 * 
 * Soporta:
 * - Swopus DEX (API con pares y reservas)
 * - Digiko DEX (API con precios de tokens)
 * 
 * Respeta el flag admin_disabled:
 * - Si un par tiene admin_disabled=true, el sync NO lo reactiva
 * - Solo el admin puede cambiar ese estado manualmente
 */

const cron = require('node-cron');
const swopus = require('../services/swopus');
const digiko = require('../services/digiko');
const syncQueries = require('../models/syncQueries');

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '30');
const MIN_RESERVE = parseInt(process.env.MIN_RESERVE || '1000000');

let pool = null;
let isRunning = false;

// ════════════════════════════════════════════════════════════════
// SWOPUS SYNC
// ════════════════════════════════════════════════════════════════

/**
 * Sincronizar pares desde Swopus
 */
async function syncSwopus() {
  console.log('[SYNC:SWOPUS] Iniciando sincronización...');

  try {
    // 1. Obtener gateway Swopus
    const gateway = await syncQueries.getGatewayBySlug(pool, 'swopus');
    if (!gateway) {
      console.log('[SYNC:SWOPUS] Gateway no encontrado, saltando');
      return { success: false, error: 'Gateway not found' };
    }
    
    // Verificar si el gateway está deshabilitado por admin
    if (gateway.admin_disabled) {
      console.log('[SYNC:SWOPUS] ⏸ Gateway deshabilitado por admin, saltando');
      return { success: true, skipped: true, reason: 'gateway_disabled' };
    }
    
    console.log(`[SYNC:SWOPUS] Gateway: ${gateway.name} (ID: ${gateway.id})`);

    // 2. Fetch datos de Swopus API
    const data = await swopus.fetchPairs();
    
    const tokensData = data.tokens || {};
    const pairsData = data.pairs || [];
    
    console.log(`[SYNC:SWOPUS] Recibidos: ${Object.keys(tokensData).length} tokens, ${pairsData.length} pares`);

    // 3. Filtrar pares con liquidez válida
    const validPairs = swopus.filterValidPairs(pairsData, MIN_RESERVE);
    console.log(`[SYNC:SWOPUS] Pares con liquidez válida: ${validPairs.length}`);

    // 4. Procesar tokens
    const tokenCache = {};
    
    for (const [tokenId, tokenInfo] of Object.entries(tokensData)) {
      const symbol = swopus.extractTokenSymbol(tokenId);
      if (!symbol || tokenCache[symbol]) continue;
      
      try {
        const token = await syncQueries.upsertToken(pool, {
          symbol: symbol,
          name: symbol,
          logo_url: swopus.buildLogoUrl(tokenInfo.logoUrlProxy),
          decimals: tokenInfo.precision || 6,
          contract_address: tokenId
        });
        tokenCache[symbol] = token.id;
      } catch (err) {
        const existing = await syncQueries.getTokenBySymbol(pool, symbol);
        if (existing) {
          tokenCache[symbol] = existing.id;
        }
      }
    }

    // 5. Procesar pares
    const updatedPairIds = [];
    let pairsUpdated = 0;
    let pairsSkipped = 0;
    
    for (const pair of validPairs) {
      const token0Symbol = swopus.extractTokenSymbol(pair.token0_id);
      const token1Symbol = swopus.extractTokenSymbol(pair.token1_id);
      
      const token0Id = tokenCache[token0Symbol];
      const token1Id = tokenCache[token1Symbol];
      
      if (!token0Id || !token1Id) continue;

      try {
        // Par directo
        const result1 = await syncQueries.upsertTradingPairRespectingAdmin(pool, {
          token_from_id: token0Id,
          token_to_id: token1Id,
          gateway_id: gateway.id,
          pair_id_external: String(pair.pair_id),
          reserve0: pair.reserve0,
          reserve1: pair.reserve1
        });
        
        if (result1.skipped) pairsSkipped++;
        else { updatedPairIds.push(result1.id); pairsUpdated++; }

        // Par inverso
        const result2 = await syncQueries.upsertTradingPairRespectingAdmin(pool, {
          token_from_id: token1Id,
          token_to_id: token0Id,
          gateway_id: gateway.id,
          pair_id_external: String(pair.pair_id),
          reserve0: pair.reserve1,
          reserve1: pair.reserve0
        });
        
        if (result2.skipped) pairsSkipped++;
        else { updatedPairIds.push(result2.id); pairsUpdated++; }

      } catch (err) {
        console.error(`[SYNC:SWOPUS] Error par ${token0Symbol}/${token1Symbol}:`, err.message);
      }
    }

    // 6. Desactivar pares sin liquidez
    const deactivated = await syncQueries.deactivateStalePairsRespectingAdmin(
      pool, gateway.id, updatedPairIds
    );
    
    console.log(`[SYNC:SWOPUS] ✔ Completado: ${pairsUpdated} actualizados, ${pairsSkipped} saltados (admin), ${deactivated.count} desactivados`);

    return { success: true, pairsUpdated, pairsSkipped, pairsDeactivated: deactivated.count };

  } catch (error) {
    console.error('[SYNC:SWOPUS] ✗ Error:', error.message);
    return { success: false, error: error.message };
  }
}

// ════════════════════════════════════════════════════════════════
// DIGIKO SYNC
// ════════════════════════════════════════════════════════════════

/**
 * Sincronizar pares desde Digiko
 */
async function syncDigiko() {
  console.log('[SYNC:DIGIKO] Iniciando sincronización...');

  try {
    // 1. Obtener o crear gateway Digiko
    let gateway = await syncQueries.getGatewayBySlug(pool, 'digiko');
    
    if (!gateway) {
      console.log('[SYNC:DIGIKO] Gateway no existe, creando...');
      gateway = await createDigikoGateway();
    }
    
    // Verificar si está deshabilitado
    if (gateway.admin_disabled) {
      console.log('[SYNC:DIGIKO] ⏸ Gateway deshabilitado por admin, saltando');
      return { success: true, skipped: true, reason: 'gateway_disabled' };
    }
    
    console.log(`[SYNC:DIGIKO] Gateway: ${gateway.name} (ID: ${gateway.id})`);

    // 2. Fetch datos de Digiko API
    const pricesData = await digiko.fetchPrices();
    
    if (!pricesData || !pricesData.prices) {
      throw new Error('Respuesta inválida de Digiko API');
    }
    
    const tokensCount = Object.keys(pricesData.prices).length;
    console.log(`[SYNC:DIGIKO] Recibidos: ${tokensCount} tokens`);

    // 3. Procesar tokens
    const tokenCache = {};
    const tokens = digiko.parseTokens(pricesData);
    
    for (const tokenData of tokens) {
      try {
        const token = await syncQueries.upsertToken(pool, {
          symbol: tokenData.symbol,
          name: tokenData.name,
          logo_url: digiko.buildLogoUrl(tokenData.symbol),
          decimals: 6,
          contract_address: null
        });
        tokenCache[tokenData.symbol] = token.id;
      } catch (err) {
        const existing = await syncQueries.getTokenBySymbol(pool, tokenData.symbol);
        if (existing) {
          tokenCache[tokenData.symbol] = existing.id;
        }
      }
    }
    
    console.log(`[SYNC:DIGIKO] Tokens procesados: ${Object.keys(tokenCache).length}`);

    // 4. Generar y procesar pares de trading
    const pairs = digiko.generateTradingPairs(pricesData);
    const updatedPairIds = [];
    let pairsUpdated = 0;
    let pairsSkipped = 0;
    
    for (const pair of pairs) {
      const tokenFromId = tokenCache[pair.token_from];
      const tokenToId = tokenCache[pair.token_to];
      
      if (!tokenFromId || !tokenToId) continue;
      
      try {
        const result = await syncQueries.upsertTradingPairRespectingAdmin(pool, {
          token_from_id: tokenFromId,
          token_to_id: tokenToId,
          gateway_id: gateway.id,
          pair_id_external: pair.pair_id_external,
          reserve0: pair.reserve0,
          reserve1: pair.reserve1
        });
        
        if (result.skipped) pairsSkipped++;
        else { updatedPairIds.push(result.id); pairsUpdated++; }
        
      } catch (err) {
        console.error(`[SYNC:DIGIKO] Error par ${pair.token_from}/${pair.token_to}:`, err.message);
      }
    }

    // 5. Desactivar pares que ya no existen
    const deactivated = await syncQueries.deactivateStalePairsRespectingAdmin(
      pool, gateway.id, updatedPairIds
    );
    
    console.log(`[SYNC:DIGIKO] ✔ Completado: ${pairsUpdated} actualizados, ${pairsSkipped} saltados (admin), ${deactivated.count} desactivados`);

    return { success: true, pairsUpdated, pairsSkipped, pairsDeactivated: deactivated.count };

  } catch (error) {
    console.error('[SYNC:DIGIKO] ✗ Error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Crear gateway Digiko si no existe
 */
async function createDigikoGateway() {
  const result = await pool.query(`
    INSERT INTO gateways (name, slug, logo_url, api_url, fee_percentage, is_active, admin_disabled)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    'Digiko DEX',
    'digiko',
    'https://digiko.io/logo.png',
    digiko.DIGIKO_API_URL,
    0.3,
    true,
    false
  ]);
  
  console.log('[SYNC:DIGIKO] Gateway creado con ID:', result.rows[0].id);
  return result.rows[0];
}

// ════════════════════════════════════════════════════════════════
// SYNC ALL GATEWAYS
// ════════════════════════════════════════════════════════════════

/**
 * Sincronizar todos los gateways
 */
async function syncAll() {
  if (isRunning) {
    console.log('[SYNC] Ya hay una sincronización en curso, saltando...');
    return { success: false, reason: 'already_running' };
  }

  isRunning = true;
  const startTime = Date.now();
  
  console.log('[SYNC] ══════════════════════════════════════');
  console.log('[SYNC] Iniciando sincronización de todos los DEX...');
  console.log('[SYNC] ══════════════════════════════════════');

  const results = {
    swopus: null,
    digiko: null
  };

  try {
    // Sincronizar Swopus
    results.swopus = await syncSwopus();
    
    // Sincronizar Digiko
    results.digiko = await syncDigiko();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // Estadísticas finales
    const stats = await getSyncStats();
    
    console.log('[SYNC] ══════════════════════════════════════');
    console.log(`[SYNC] ✔ Sincronización completa en ${elapsed}s`);
    console.log(`[SYNC]   Swopus: ${results.swopus.success ? '✔' : '✗'} ${results.swopus.pairsUpdated || 0} pares`);
    console.log(`[SYNC]   Digiko: ${results.digiko.success ? '✔' : '✗'} ${results.digiko.pairsUpdated || 0} pares`);
    console.log(`[SYNC]   Total pares activos: ${stats.totalActivePairs}`);
    console.log(`[SYNC]   Total tokens: ${stats.totalTokens}`);
    console.log('[SYNC] ══════════════════════════════════════');

    return { success: true, results, elapsed, stats };

  } catch (error) {
    console.error('[SYNC] ✗ Error general:', error.message);
    return { success: false, error: error.message, results };
  } finally {
    isRunning = false;
  }
}

/**
 * Obtener estadísticas de sincronización
 */
async function getSyncStats() {
  try {
    const pairsResult = await pool.query(
      'SELECT COUNT(*) as count FROM trading_pairs WHERE is_active = true'
    );
    const tokensResult = await pool.query(
      'SELECT COUNT(*) as count FROM tokens WHERE is_active = true'
    );
    
    return {
      totalActivePairs: parseInt(pairsResult.rows[0].count),
      totalTokens: parseInt(tokensResult.rows[0].count)
    };
  } catch (err) {
    return { totalActivePairs: 0, totalTokens: 0 };
  }
}

// ════════════════════════════════════════════════════════════════
// WORKER MANAGEMENT
// ════════════════════════════════════════════════════════════════

/**
 * Iniciar el sync worker
 */
function startSyncWorker(dbPool) {
  pool = dbPool;
  
  console.log(`[SYNC] ✔ Sync Worker iniciado (cada ${SYNC_INTERVAL_MINUTES} minutos)`);
  console.log('[SYNC]   Gateways: Swopus, Digiko');
  
  // Ejecutar inmediatamente al iniciar
  setTimeout(() => {
    console.log('[SYNC] Ejecutando sincronización inicial...');
    syncAll().catch(err => console.error('[SYNC] Error inicial:', err.message));
  }, 5000);
  
  // Programar ejecuciones periódicas
  const cronExpression = `*/${SYNC_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpression, () => {
    syncAll().catch(err => console.error('[SYNC] Error en cron:', err.message));
  });
}

/**
 * Ejecutar sincronización manual de todos los gateways
 */
async function runManualSync() {
  if (!pool) throw new Error('Sync worker no inicializado');
  return syncAll();
}

/**
 * Ejecutar sincronización manual de un gateway específico
 */
async function runManualSyncGateway(gatewaySlug) {
  if (!pool) throw new Error('Sync worker no inicializado');
  
  switch (gatewaySlug.toLowerCase()) {
    case 'swopus':
      return syncSwopus();
    case 'digiko':
      return syncDigiko();
    default:
      throw new Error(`Gateway no soportado: ${gatewaySlug}`);
  }
}

module.exports = {
  startSyncWorker,
  runManualSync,
  runManualSyncGateway,
  syncSwopus,
  syncDigiko,
  syncAll
};
