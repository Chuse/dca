/**
 * Sync Worker - Sincroniza pares de trading desde Swopus DEX
 * 
 * Funcionalidades:
 * - Fetch de pares cada X minutos (configurable)
 * - Upsert de tokens y pares en BD
 * - Cálculo de precios desde reserves
 * - Desactivación de pares sin liquidez
 */

const cron = require('node-cron');
const swopus = require('../services/swopus');
const syncQueries = require('../models/syncQueries');

// Configuración
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '5');
const MIN_RESERVE = parseInt(process.env.MIN_RESERVE || '1000000'); // 1 token con 6 decimales

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
      throw new Error('Gateway Swopus no encontrado en BD. Ejecutar migración primero.');
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

    // 4. Procesar tokens
    const tokenCache = {}; // symbol -> id
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
        // Si falla por constraint, intentar obtener el existente
        const existing = await syncQueries.getTokenBySymbol(pool, symbol);
        if (existing) {
          tokenCache[symbol] = existing.id;
        }
      }
    }
    console.log(`[SYNC] Tokens en cache: ${Object.keys(tokenCache).length}`);

    // 5. Procesar pares (bidireccionales)
    const updatedPairIds = [];
    let pairsCreated = 0;
    let pairsUpdated = 0;

    console.log('[SYNC] Procesando pares...');
    
    for (const pair of validPairs) {
      const token0Symbol = swopus.extractTokenSymbol(pair.token0_id);
      const token1Symbol = swopus.extractTokenSymbol(pair.token1_id);
      
      const token0Id = tokenCache[token0Symbol];
      const token1Id = tokenCache[token1Symbol];
      
      if (!token0Id || !token1Id) {
        console.log(`[SYNC] ⚠ Saltando par ${token0Symbol}/${token1Symbol}: tokens no encontrados`);
        continue;
      }

      try {
        // Par directo: token0 -> token1
        const pair1 = await syncQueries.upsertTradingPair(pool, {
          token_from_id: token0Id,
          token_to_id: token1Id,
          gateway_id: gateway.id,
          pair_id_external: String(pair.pair_id),
          reserve0: pair.reserve0,
          reserve1: pair.reserve1
        });
        updatedPairIds.push(pair1.id);

        // Par inverso: token1 -> token0
        const pair2 = await syncQueries.upsertTradingPair(pool, {
          token_from_id: token1Id,
          token_to_id: token0Id,
          gateway_id: gateway.id,
          pair_id_external: String(pair.pair_id),
          reserve0: pair.reserve1, // invertido
          reserve1: pair.reserve0  // invertido
        });
        updatedPairIds.push(pair2.id);

        pairsUpdated += 2;
      } catch (err) {
        console.error(`[SYNC] Error procesando par ${token0Symbol}/${token1Symbol}:`, err.message);
      }
    }

    // 6. Desactivar pares que ya no existen en Swopus
    const deactivated = await syncQueries.deactivateStalePairs(pool, gateway.id, updatedPairIds);
    
    // 7. Estadísticas finales
    const stats = await syncQueries.getSyncStats(pool, gateway.id);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('[SYNC] ──────────────────────────────────────');
    console.log(`[SYNC] ✔ Sincronización completada en ${elapsed}s`);
    console.log(`[SYNC]   Pares actualizados: ${pairsUpdated}`);
    console.log(`[SYNC]   Pares desactivados: ${deactivated.count}`);
    console.log(`[SYNC]   Total pares activos: ${stats.active_pairs}`);
    console.log('[SYNC] ══════════════════════════════════════');

    return {
      success: true,
      pairsUpdated,
      pairsDeactivated: deactivated.count,
      activePairs: parseInt(stats.active_pairs),
      elapsed
    };

  } catch (error) {
    console.error('[SYNC] ✗ Error en sincronización:', error.message);
    return {
      success: false,
      error: error.message
    };
  } finally {
    isRunning = false;
  }
}

/**
 * Iniciar el sync worker con cron
 */
function startSyncWorker(dbPool) {
  pool = dbPool;
  
  console.log(`[SYNC] ✔ Sync Worker iniciado (cada ${SYNC_INTERVAL_MINUTES} minutos)`);
  
  // Ejecutar inmediatamente al iniciar
  setTimeout(() => {
    console.log('[SYNC] Ejecutando sincronización inicial...');
    syncSwopus().catch(err => console.error('[SYNC] Error inicial:', err.message));
  }, 5000); // Esperar 5 segundos para que el servidor esté listo
  
  // Programar ejecuciones periódicas
  const cronExpression = `*/${SYNC_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpression, () => {
    syncSwopus().catch(err => console.error('[SYNC] Error en cron:', err.message));
  });
}

/**
 * Ejecutar sincronización manual (para API de admin)
 */
async function runManualSync() {
  if (!pool) {
    throw new Error('Sync worker no inicializado');
  }
  return syncSwopus();
}

module.exports = {
  startSyncWorker,
  runManualSync,
  syncSwopus
};
