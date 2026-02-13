/**
 * KleverDCA — Sync Worker
 * Sincroniza tokens y pares de trading desde Bitcoin.me DeFi
 *
 * CAMBIOS vs versión anterior:
 *   - Bitcoin.me DeFi como único gateway activo
 *   - Swopus y Digiko desactivados (no eliminados, por si necesitas reactivar)
 *   - Usa services/bitcoinme.js para fetch + mapping
 *   - Descarga iconos localmente para no depender de URLs externas
 *   - Precio USD de cada token almacenado para referencia del P2P
 *
 * CRON: Cada 30 minutos (configurable via SYNC_INTERVAL_MINUTES)
 */

const cron = require('node-cron');
const bitcoinme = require('../services/bitcoinme');
const syncQueries = require('../models/syncQueries');
const path = require('path');
const fs = require('fs');

// ════════════════════════════════════════
// Configuration
// ════════════════════════════════════════

const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 30;
const MIN_RESERVE = parseInt(process.env.MIN_RESERVE) || 1000000;
const DOWNLOAD_ICONS = process.env.DOWNLOAD_ICONS !== 'false'; // default true
const ICONS_DIR = process.env.ICONS_DIR || path.join(__dirname, '..', 'public', 'img', 'tokens');
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS) || 15000;

// ════════════════════════════════════════
// Fetch with timeout (Node 18 compatible)
// ════════════════════════════════════════

function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

// ════════════════════════════════════════
// Icon downloader
// ════════════════════════════════════════

/**
 * Download a token icon to local filesystem
 * Returns the local path on success, original URL on failure
 */
async function downloadIcon(iconUrl, symbol) {
  if (!iconUrl || !DOWNLOAD_ICONS) return iconUrl;

  try {
    // Ensure directory exists
    if (!fs.existsSync(ICONS_DIR)) {
      fs.mkdirSync(ICONS_DIR, { recursive: true });
    }

    const ext = path.extname(new URL(iconUrl).pathname) || '.png';
    const filename = `${symbol.toLowerCase()}${ext}`;
    const filepath = path.join(ICONS_DIR, filename);

    // Skip if already downloaded and recent (< 24h)
    if (fs.existsSync(filepath)) {
      const stats = fs.statSync(filepath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < 24) {
        return `/img/tokens/${filename}`;
      }
    }

    const response = await fetch(iconUrl);
    if (!response.ok) return iconUrl;

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filepath, buffer);

    console.log(`[Sync] Icon downloaded: ${symbol} → ${filename}`);
    return `/img/tokens/${filename}`;
  } catch (err) {
    console.warn(`[Sync] Icon download failed for ${symbol}:`, err.message);
    return iconUrl; // Fallback to remote URL
  }
}

// ════════════════════════════════════════
// Main sync function
// ════════════════════════════════════════

async function syncBitcoinme(pool) {
  const startTime = Date.now();
  console.log('[Sync] ══════════════════════════════════════');
  console.log('[Sync] Starting Bitcoin.me DeFi sync...');

  try {
    // ── 1. Check API health (non-blocking) ──
    try {
      const health = await fetchWithTimeout(bitcoinme.getBaseUrl() + '/health', 10000);
      const data = await health.json();
      if (data.status !== 'OK') {
        console.warn('[Sync] API health unexpected:', JSON.stringify(data));
      } else {
        console.log('[Sync] API health: OK');
      }
    } catch (healthErr) {
      console.warn('[Sync] API health check failed:', healthErr.message);
      console.warn('[Sync] Will attempt sync anyway...');
    }

    // ── 2. Get or create gateway ──
    let gateway = await syncQueries.getGatewayBySlug(pool, 'bitcoinme');

    if (!gateway) {
      console.log('[Sync] Creating "bitcoinme" gateway...');
      gateway = await createBitcoinmeGateway(pool);
    }

    if (gateway.admin_disabled) {
      console.log('[Sync] Gateway "bitcoinme" is disabled by admin. Skipping.');
      return { skipped: true, reason: 'gateway_disabled' };
    }

    // ── 3. Fetch tokens and pools from API ──
    console.log('[Sync] Fetching tokens and pools...');
    const { tokens, pools } = await bitcoinme.fetchAll();
    console.log(`[Sync] Received: ${tokens.length} tokens, ${pools.length} pools`);

    // ── 4. Filter pools with valid liquidity ──
    const validPools = bitcoinme.filterValidPools(pools, MIN_RESERVE);
    console.log(`[Sync] Valid pools (reserve >= ${MIN_RESERVE}): ${validPools.length}`);

    // ── 5. Process tokens ──
    let tokensUpserted = 0;
    let tokensSkipped = 0;

    for (const token of tokens) {
      const mapped = bitcoinme.mapTokenToDb(token);

      // Download icon locally
      if (mapped.logo_url) {
        mapped.logo_url = await downloadIcon(mapped.logo_url, mapped.symbol);
      }

      try {
        await syncQueries.upsertToken(pool, {
          symbol:           mapped.symbol,
          name:             mapped.name,
          decimals:         mapped.decimals,
          logo_url:         mapped.logo_url,
          contract_address: mapped.contract_address,
          is_active:        mapped.is_active,
          is_stablecoin:    mapped.is_stablecoin,
        });
        tokensUpserted++;
      } catch (err) {
        // Respect admin_disabled — upsertToken should handle this
        console.warn(`[Sync] Token ${mapped.symbol} skipped:`, err.message);
        tokensSkipped++;
      }
    }
    console.log(`[Sync] Tokens: ${tokensUpserted} upserted, ${tokensSkipped} skipped`);

    // ── 6. Process pools → trading pairs (bidirectional) ──
    let pairsUpserted = 0;
    let pairsSkipped = 0;
    const upsertedPairIds = [];

    for (const p of validPools) {
      const tradingPairs = bitcoinme.mapPoolToTradingPairs(p, gateway.id);

      for (const tp of tradingPairs) {
        // Resolve token IDs from symbols
        const tokenFrom = await syncQueries.getTokenBySymbol(pool, tp.token_from_symbol);
        const tokenTo = await syncQueries.getTokenBySymbol(pool, tp.token_to_symbol);

        if (!tokenFrom || !tokenTo) {
          pairsSkipped++;
          continue;
        }

        try {
          const result = await syncQueries.upsertTradingPairRespectingAdmin(pool, {
            token_from_id:    tokenFrom.id,
            token_to_id:      tokenTo.id,
            gateway_id:       gateway.id,
            pair_id_external: tp.pair_id_external,
            reserve0:         tp.reserve0,
            reserve1:         tp.reserve1,
          });
          if (result && result.id) upsertedPairIds.push(result.id);
          pairsUpserted++;
        } catch (err) {
          console.warn(`[Sync] Pair ${tp.token_from_symbol}→${tp.token_to_symbol} skipped:`, err.message);
          pairsSkipped++;
        }
      }
    }
    console.log(`[Sync] Pairs: ${pairsUpserted} upserted, ${pairsSkipped} skipped`);

    // ── 7. Deactivate stale pairs ──
    // Pass the integer IDs of pairs we just upserted
    if (upsertedPairIds.length > 0) {
      await syncQueries.deactivateStalePairsRespectingAdmin(
        pool,
        gateway.id,
        upsertedPairIds
      );
      console.log('[Sync] Stale pairs deactivated');
    }

    // ── 8. Update price cache ──
    // Store latest USD prices for use by P2P reference pricing
    await updatePriceCache(pool, tokens);

    // ── Done ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Sync] ✅ Bitcoin.me sync complete in ${elapsed}s`);
    console.log(`[Sync]    ${tokensUpserted} tokens, ${pairsUpserted} pairs`);
    console.log('[Sync] ══════════════════════════════════════');

    return {
      success: true,
      tokens: tokensUpserted,
      pairs: pairsUpserted,
      elapsed: parseFloat(elapsed),
    };

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[Sync] ❌ Bitcoin.me sync failed after ${elapsed}s:`, err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════
// Helper: Create gateway if not exists
// ════════════════════════════════════════

async function createBitcoinmeGateway(pool) {
  const result = await pool.query(`
    INSERT INTO gateways (name, slug, api_url, is_active, admin_disabled)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      api_url = EXCLUDED.api_url
    RETURNING *
  `, [
    'Bitcoin.me DeFi',
    'bitcoinme',
    bitcoinme.getBaseUrl(),
    true,
    false
  ]);
  return result.rows[0];
}

// ════════════════════════════════════════
// Helper: Update price cache
// ════════════════════════════════════════

/**
 * Store latest token prices for cross-product reference
 * Used by P2P Marketplace to show "±X% vs DEX" and by DCA for execution
 *
 * If your DB doesn't have a token_prices table yet, this creates one.
 * If you prefer to store prices in the tokens table, just modify this.
 */
async function updatePriceCache(pool, tokens) {
  // Ensure price cache table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_prices (
      symbol VARCHAR(20) PRIMARY KEY,
      contract_address VARCHAR(100),
      price_usd DECIMAL(20, 10) DEFAULT 0,
      variation_pct DECIMAL(10, 4) DEFAULT 0,
      last_volume VARCHAR(50) DEFAULT '0',
      icon_url TEXT,
      source VARCHAR(20) DEFAULT 'bitcoinme',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  let updated = 0;
  for (const token of tokens) {
    const symbol = bitcoinme.extractTokenSymbol(token.tokenInID);
    const priceUsd = parseFloat(token.price) || 0;

    if (priceUsd > 0) {
      await pool.query(`
        INSERT INTO token_prices (symbol, contract_address, price_usd, variation_pct, last_volume, icon_url, source, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'bitcoinme', NOW())
        ON CONFLICT (symbol) DO UPDATE SET
          price_usd = EXCLUDED.price_usd,
          variation_pct = EXCLUDED.variation_pct,
          last_volume = EXCLUDED.last_volume,
          icon_url = EXCLUDED.icon_url,
          source = EXCLUDED.source,
          updated_at = NOW()
      `, [symbol, token.tokenInID, priceUsd, token.variationPercent || 0, token.lastVolume || '0', token.iconURL]);
      updated++;
    }
  }

  console.log(`[Sync] Price cache: ${updated} tokens updated`);
}

// ════════════════════════════════════════
// Helper: Disable other gateways
// ════════════════════════════════════════

/**
 * Deactivate Swopus and Digiko gateways
 * Call once during migration, or on first run
 */
async function disableOtherGateways(pool) {
  const result = await pool.query(`
    UPDATE gateways
    SET is_active = false
    WHERE slug IN ('swopus', 'digiko')
      AND is_active = true
    RETURNING slug
  `);

  if (result.rows.length > 0) {
    const disabled = result.rows.map(r => r.slug).join(', ');
    console.log(`[Sync] Disabled gateways: ${disabled}`);
  }
}

// ════════════════════════════════════════
// Cron scheduler
// ════════════════════════════════════════

function startSyncScheduler(pool) {
  console.log(`[Sync] Scheduler started — every ${SYNC_INTERVAL_MINUTES} minutes`);
  console.log(`[Sync] Source: Bitcoin.me DeFi (${bitcoinme.getBaseUrl()})`);
  console.log(`[Sync] Min reserve: ${MIN_RESERVE}`);
  console.log(`[Sync] Icons: ${DOWNLOAD_ICONS ? 'local download → ' + ICONS_DIR : 'remote URLs'}`);

  // First run: disable other gateways and sync immediately
  (async () => {
    try {
      await disableOtherGateways(pool);
      await syncBitcoinme(pool);
    } catch (err) {
      console.error('[Sync] Initial sync failed:', err.message);
      console.error('[Sync] Server continues running — will retry on next cron cycle');
    }
  })();

  // Schedule recurring sync
  const cronExpr = `*/${SYNC_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpr, async () => {
    await syncBitcoinme(pool);
  });
}

// ════════════════════════════════════════
// Exports
// ════════════════════════════════════════

module.exports = {
  syncBitcoinme,
  startSyncScheduler,
  disableOtherGateways,
  updatePriceCache,
};
