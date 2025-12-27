/**
 * Sync Worker - Sincroniza pares de trading desde Swopus DEX
 * 
 * Respeta el flag admin_disabled:
 * - Si un par tiene admin_disabled=true, el sync NO lo reactiva
 * - Solo el admin puede cambiar ese estado manualmente
 */

const cron = require('node-cron');
const swopus = require('../services/swopus');
const syncQueries = require('../models/syncQueries');

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '30');
const MIN_RESERVE = parseInt(process.env.MIN_RESERVE || '1000000');

let pool = null;
let isRunning = false;

/**
 * Sincronizar pares desde Swopus
 */
async function syncSwopus() {
  if (isRunning) {
    console.log('[SYNC] Ya hay una sincronización en curso, saltando...');
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  
  console.log('[SYNC] ══════════════════════════════════════');
  console.log('[SYNC] Iniciando sincronización con Swopus...');

  try {
    // 1. Obtener gateway Swopus
    const gateway = await syncQueries.getGatewayBySlug(pool, 'swopus');
    if (!gateway) {
      throw new Error('Gateway Swopus no encontrado en BD');
    }
    
    // Verificar si el gateway está deshabilitado por admin
    if (gateway.admin_disabled) {
      console.log('[SYNC] ⏸ Gateway Swopus deshabilitado por admin, saltando sync');
      return { success: true, skipped: true, reason: 'gateway_disabled' };
    }
    
    console.log(`[SYNC] Gateway: ${gateway.name} (ID: ${gateway.id})`);

    // 2. Fetch datos de Swopus API
    console.log('[SYNC] Consultando API de Swopus...');
    const data = await swopus.fetchPairs();
    
    const tokensData = data.tokens || {};
    const pairsData = data.pairs || [];
    
    console.log(`[SYNC] Recibidos: ${Object.keys(tokensData).length} tokens, ${pairsData.length} pares`);

    // 3. Filtrar pares con liquidez válida
    const validPairs = swopus.filterValidPairs(pairsData, MIN_RESERVE);
    console.log(`[SYNC] Pares con liquidez válida: ${validPairs.length}`);

    // 4. Procesar tokens (respetando admin_disabled)
    const tokenCache = {};
    console.log('[SYNC] Procesando tokens...');
    
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
    console.log(`[SYNC] Tokens en cache: ${Object.keys(tokenCache).length}`);

    // 5. Procesar pares (respetando admin_disabled)
    const updatedPairIds = [];
    let pairsUpdated = 0;
    let pairsSkipped = 0;

    console.log('[SYNC] Procesando pares...');
    
    for (const pair of validPairs) {
      const token0Symbol = swopus.extractTokenSymbol(pair.token0_id);
      const token1Symbol = swopus.extractTokenSymbol(pair.token1_id);
      
      const token0Id = tokenCache[token0Symbol];
      const token1Id = tokenCache[token1Symbol];
      
      if (!token0Id || !token1Id) continue;

      try {
        // Par directo: token0 -> token1
        const result1 = await syncQueries.upsertTradingPairRespectingAdmin(pool, {
          token_from_id: token0Id,
          token_to_id: token1Id,
          gateway_id: gateway.id,
          pair_id_external: String(pair.pair_id),
          reserve0: pair.reserve0,
          reserve1: pair.reserve1
        });
        
        if (result1.skipped) {
          pairsSkipped++;
        } else {
          updatedPairIds.push(result1.id);
          pairsUpdated++;
        }

        // Par inverso: token1 -> token0
        const result2 = await syncQueries.upsertTradingPairRespectingAdmin(pool, {
          token_from_id: token1Id,
          token_to_id: token0Id,
          gateway_id: gateway.id,
          pair_id_external: String(pair.pair_id),
          reserve0: pair.reserve1,
          reserve1: pair.reserve0
        });
        
        if (result2.skipped) {
          pairsSkipped++;
        } else {
          updatedPairIds.push(result2.id);
          pairsUpdated++;
        }

      } catch (err) {
        console.error(`[SYNC] Error procesando par ${token0Symbol}/${token1Symbol}:`, err.message);
      }
    }

    // 6. Desactivar pares sin liquidez (respetando admin_disabled)
    const deactivated = await syncQueries.deactivateStalePairsRespectingAdmin(
      pool, gateway.id, updatedPairIds
    );
    
    // 7. Estadísticas
    const stats = await syncQueries.getSyncStats(pool, gateway.id);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('[SYNC] ──────────────────────────────────────');
    console.log(`[SYNC] ✔ Sincronización completada en ${elapsed}s`);
    console.log(`[SYNC]   Pares actualizados: ${pairsUpdated}`);
    console.log(`[SYNC]   Pares saltados (admin_disabled): ${pairsSkipped}`);
    console.log(`[SYNC]   Pares desactivados: ${deactivated.count}`);
    console.log(`[SYNC]   Total pares activos: ${stats.active_pairs}`);
    console.log('[SYNC] ══════════════════════════════════════');

    return {
      success: true,
      pairsUpdated,
      pairsSkipped,
      pairsDeactivated: deactivated.count,
      activePairs: parseInt(stats.active_pairs),
      elapsed
    };

  } catch (error) {
    console.error('[SYNC] ✗ Error en sincronización:', error.message);
    return { success: false, error: error.message };
  } finally {
    isRunning = false;
  }
}

/**
 * Iniciar el sync worker
 */
function startSyncWorker(dbPool) {
  pool = dbPool;
  
  console.log(`[SYNC] ✔ Sync Worker iniciado (cada ${SYNC_INTERVAL_MINUTES} minutos)`);
  
  // Ejecutar inmediatamente al iniciar
  setTimeout(() => {
    console.log('[SYNC] Ejecutando sincronización inicial...');
    syncSwopus().catch(err => console.error('[SYNC] Error inicial:', err.message));
  }, 5000);
  
  // Programar ejecuciones periódicas
  const cronExpression = `*/${SYNC_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpression, () => {
    syncSwopus().catch(err => console.error('[SYNC] Error en cron:', err.message));
  });
}

/**
 * Ejecutar sincronización manual
 */
async function runManualSync() {
  if (!pool) throw new Error('Sync worker no inicializado');
  return syncSwopus();
}

module.exports = {
  startSyncWorker,
  runManualSync,
  syncSwopus
};
