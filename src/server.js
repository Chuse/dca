require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');
const adminAuth = require('./middleware/adminAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// DATABASE CONNECTION
// ============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('Nueva conexión al pool de PostgreSQL'));
pool.on('error', (err) => console.error('Error en PostgreSQL:', err));

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: [process.env.CORS_ORIGIN, 'http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// HEALTH CHECK (público)
// ============================================
app.get('/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW()');
    const syncStatus = await pool.query(
      `SELECT COUNT(*) as active_pairs, MAX(last_sync_at) as last_sync 
       FROM trading_pairs WHERE is_active = true AND admin_disabled = false`
    );
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      dbTime: dbCheck.rows[0].now,
      syncWorker: process.env.ENABLE_SYNC_WORKER !== 'false' ? 'enabled' : 'disabled',
      activePairs: parseInt(syncStatus.rows[0].active_pairs) || 0,
      lastSync: syncStatus.rows[0].last_sync
    });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: error.message });
  }
});

// ============================================
// PUBLIC API - Users
// ============================================
app.post('/api/users', async (req, res) => {
  try {
    const { wallet_address } = req.body;
    if (!wallet_address) return res.status(400).json({ error: 'wallet_address es requerido' });

    const result = await pool.query(
      `INSERT INTO users (wallet_address) VALUES ($1) 
       ON CONFLICT (wallet_address) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [wallet_address]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// ============================================
// PUBLIC API - DCA Orders
// ============================================
app.post('/api/dca/create', async (req, res) => {
  try {
    const { wallet_address, token_from, token_to, amount, frequency } = req.body;
    if (!wallet_address || !token_from || !token_to || !amount || !frequency) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const minAmount = parseFloat(process.env.MIN_TRANSACTION_AMOUNT || 1);
    const maxAmount = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || 10000);
    if (amount < minAmount || amount > maxAmount) {
      return res.status(400).json({ error: `Monto debe estar entre ${minAmount} y ${maxAmount}` });
    }

    const userResult = await pool.query(
      `INSERT INTO users (wallet_address) VALUES ($1) 
       ON CONFLICT (wallet_address) DO UPDATE SET updated_at = NOW() RETURNING id`,
      [wallet_address]
    );
    const userId = userResult.rows[0].id;
    const nextExecution = calculateNextExecution(frequency);

    const orderResult = await pool.query(
      `INSERT INTO dca_orders (user_id, token_from, token_to, amount, frequency, next_execution) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, token_from, token_to, amount, frequency, nextExecution]
    );
    res.json(orderResult.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear orden DCA' });
  }
});

app.get('/api/dca/orders/:wallet_address', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dca.* FROM dca_orders dca
       JOIN users u ON dca.user_id = u.id
       WHERE u.wallet_address = $1 ORDER BY dca.created_at DESC`,
      [req.params.wallet_address]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener órdenes' });
  }
});

app.delete('/api/dca/orders/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    const orderResult = await pool.query('SELECT * FROM dca_orders WHERE id = $1', [order_id]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Orden no encontrada' });

    const order = orderResult.rows[0];
    await pool.query('UPDATE dca_orders SET is_active = false, updated_at = NOW() WHERE id = $1', [order_id]);
    res.json({ success: true, message: 'Orden cancelada' });
  } catch (error) {
    res.status(500).json({ error: 'Error al cancelar orden' });
  }
});

// ============================================
// PUBLIC API - Transactions & Stats
// ============================================
app.get('/api/transactions/:wallet_address', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.* FROM transactions t JOIN users u ON t.user_id = u.id
       WHERE u.wallet_address = $1 ORDER BY t.executed_at DESC LIMIT 50`,
      [req.params.wallet_address]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

app.get('/api/stats/:wallet_address', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM user_stats WHERE wallet_address = $1', [req.params.wallet_address]);
    res.json(result.rows[0] || { total_dca_orders: 0, active_orders: 0, total_transactions: 0 });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ============================================
// PUBLIC API - Tokens, Gateways, Pairs, Prices
// ============================================
app.get('/api/tokens/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, symbol, name, logo_url, decimals FROM tokens 
       WHERE is_active = true AND admin_disabled = false ORDER BY symbol`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tokens' });
  }
});

app.get('/api/gateways/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, logo_url, fee_percentage FROM gateways 
       WHERE is_active = true AND admin_disabled = false ORDER BY name`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener gateways' });
  }
});

app.get('/api/trading-pairs/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tp.id, tp.reserve0, tp.reserve1, tp.last_sync_at,
              tf.symbol as token_from_symbol, tf.logo_url as token_from_logo,
              tt.symbol as token_to_symbol, tt.logo_url as token_to_logo,
              g.name as gateway_name, g.fee_percentage as gateway_fee,
              CASE WHEN tp.reserve1 > 0 THEN (tp.reserve0::numeric / tp.reserve1::numeric) ELSE 0 END as price
       FROM trading_pairs tp
       JOIN tokens tf ON tp.token_from_id = tf.id
       JOIN tokens tt ON tp.token_to_id = tt.id
       JOIN gateways g ON tp.gateway_id = g.id
       WHERE tp.is_active = true AND tp.admin_disabled = false
         AND tf.is_active = true AND tf.admin_disabled = false
         AND tt.is_active = true AND tt.admin_disabled = false
         AND g.is_active = true AND g.admin_disabled = false
       ORDER BY tf.symbol, tt.symbol`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pares' });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tf.symbol as from_symbol, tt.symbol as to_symbol, g.slug as gateway,
              CASE WHEN tp.reserve1 > 0 THEN (tp.reserve0::numeric / tp.reserve1::numeric) ELSE 0 END as price,
              tp.last_sync_at
       FROM trading_pairs tp
       JOIN tokens tf ON tp.token_from_id = tf.id
       JOIN tokens tt ON tp.token_to_id = tt.id
       JOIN gateways g ON tp.gateway_id = g.id
       WHERE tp.is_active = true AND tp.admin_disabled = false
       ORDER BY tf.symbol, tt.symbol`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener precios' });
  }
});

app.get('/api/price/:from/:to', async (req, res) => {
  try {
    const { from, to } = req.params;
    const result = await pool.query(
      `SELECT tf.symbol as from_symbol, tt.symbol as to_symbol, g.name as gateway,
              g.fee_percentage as fee, tp.reserve0, tp.reserve1,
              CASE WHEN tp.reserve1 > 0 THEN (tp.reserve0::numeric / tp.reserve1::numeric) ELSE 0 END as price,
              tp.last_sync_at
       FROM trading_pairs tp
       JOIN tokens tf ON tp.token_from_id = tf.id
       JOIN tokens tt ON tp.token_to_id = tt.id
       JOIN gateways g ON tp.gateway_id = g.id
       WHERE UPPER(tf.symbol) = UPPER($1) AND UPPER(tt.symbol) = UPPER($2)
         AND tp.is_active = true AND tp.admin_disabled = false
       ORDER BY price ASC`,
      [from, to]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Par no encontrado' });
    res.json({ pair: `${from}/${to}`, best_price: result.rows[0], all_prices: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener precio' });
  }
});

// ============================================
// ADMIN API - Protegido con API Key
// ============================================
app.use('/api/admin', adminAuth);

// --- TOKENS ---
app.get('/api/admin/tokens', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tokens ORDER BY symbol ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tokens' });
  }
});

app.get('/api/admin/tokens/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tokens WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener token' });
  }
});

app.post('/api/admin/tokens', async (req, res) => {
  try {
    const { symbol, name, logo_url, decimals, contract_address, is_active } = req.body;
    if (!symbol || !name) return res.status(400).json({ error: 'Símbolo y nombre requeridos' });
    
    const result = await pool.query(
      `INSERT INTO tokens (symbol, name, logo_url, decimals, contract_address, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [symbol.toUpperCase(), name, logo_url, decimals || 6, contract_address, is_active !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear token' });
  }
});

app.put('/api/admin/tokens/:id', async (req, res) => {
  try {
    const { symbol, name, logo_url, decimals, contract_address, is_active } = req.body;
    const result = await pool.query(
      `UPDATE tokens SET symbol=$1, name=$2, logo_url=$3, decimals=$4, contract_address=$5, is_active=$6
       WHERE id=$7 RETURNING *`,
      [symbol.toUpperCase(), name, logo_url, decimals || 6, contract_address, is_active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar token' });
  }
});

// Toggle admin_disabled para tokens
app.patch('/api/admin/tokens/:id/toggle', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE tokens SET admin_disabled = NOT admin_disabled, is_active = NOT admin_disabled
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token no encontrado' });
    res.json({ 
      success: true, 
      token: result.rows[0],
      message: result.rows[0].admin_disabled ? 'Token deshabilitado' : 'Token habilitado'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado del token' });
  }
});

app.delete('/api/admin/tokens/:id', async (req, res) => {
  try {
    const pairsCheck = await pool.query(
      'SELECT id FROM trading_pairs WHERE token_from_id = $1 OR token_to_id = $1', [req.params.id]
    );
    if (pairsCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Token en uso. Usa toggle para deshabilitar.' });
    }
    const result = await pool.query('DELETE FROM tokens WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token no encontrado' });
    res.json({ message: 'Token eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar token' });
  }
});

// --- GATEWAYS ---
app.get('/api/admin/gateways', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM gateways ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener gateways' });
  }
});

app.get('/api/admin/gateways/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM gateways WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gateway no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener gateway' });
  }
});

app.post('/api/admin/gateways', async (req, res) => {
  try {
    const { name, slug, logo_url, api_url, fee_percentage, is_active } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Nombre y slug requeridos' });
    
    const result = await pool.query(
      `INSERT INTO gateways (name, slug, logo_url, api_url, fee_percentage, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, slug.toLowerCase(), logo_url, api_url, fee_percentage || 0.3, is_active !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear gateway' });
  }
});

app.put('/api/admin/gateways/:id', async (req, res) => {
  try {
    const { name, slug, logo_url, api_url, fee_percentage, is_active } = req.body;
    const result = await pool.query(
      `UPDATE gateways SET name=$1, slug=$2, logo_url=$3, api_url=$4, fee_percentage=$5, is_active=$6
       WHERE id=$7 RETURNING *`,
      [name, slug.toLowerCase(), logo_url, api_url, fee_percentage || 0.3, is_active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gateway no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar gateway' });
  }
});

// Toggle admin_disabled para gateways
app.patch('/api/admin/gateways/:id/toggle', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE gateways SET admin_disabled = NOT admin_disabled, is_active = NOT admin_disabled
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gateway no encontrado' });
    res.json({ 
      success: true, 
      gateway: result.rows[0],
      message: result.rows[0].admin_disabled ? 'Gateway deshabilitado (sync pausado)' : 'Gateway habilitado'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado del gateway' });
  }
});

app.delete('/api/admin/gateways/:id', async (req, res) => {
  try {
    const pairsCheck = await pool.query('SELECT id FROM trading_pairs WHERE gateway_id = $1', [req.params.id]);
    if (pairsCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Gateway en uso. Usa toggle para deshabilitar.' });
    }
    const result = await pool.query('DELETE FROM gateways WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gateway no encontrado' });
    res.json({ message: 'Gateway eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar gateway' });
  }
});

// --- TRADING PAIRS ---
app.get('/api/admin/trading-pairs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tp.*, tf.symbol as token_from_symbol, tt.symbol as token_to_symbol, 
              g.name as gateway_name,
              CASE WHEN tp.reserve1 > 0 THEN (tp.reserve0::numeric / tp.reserve1::numeric) ELSE 0 END as price
       FROM trading_pairs tp
       LEFT JOIN tokens tf ON tp.token_from_id = tf.id
       LEFT JOIN tokens tt ON tp.token_to_id = tt.id
       LEFT JOIN gateways g ON tp.gateway_id = g.id
       ORDER BY tf.symbol, tt.symbol`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pares' });
  }
});

app.get('/api/admin/trading-pairs/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tp.*, tf.symbol as token_from_symbol, tt.symbol as token_to_symbol, g.name as gateway_name
       FROM trading_pairs tp
       LEFT JOIN tokens tf ON tp.token_from_id = tf.id
       LEFT JOIN tokens tt ON tp.token_to_id = tt.id
       LEFT JOIN gateways g ON tp.gateway_id = g.id
       WHERE tp.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Par no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener par' });
  }
});

// Toggle admin_disabled para trading pairs
app.patch('/api/admin/trading-pairs/:id/toggle', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE trading_pairs SET admin_disabled = NOT admin_disabled, is_active = NOT admin_disabled
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Par no encontrado' });
    res.json({ 
      success: true, 
      pair: result.rows[0],
      message: result.rows[0].admin_disabled ? 'Par deshabilitado (sync no lo reactivará)' : 'Par habilitado'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado del par' });
  }
});

app.delete('/api/admin/trading-pairs/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM trading_pairs WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Par no encontrado' });
    res.json({ message: 'Par eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar par' });
  }
});

// --- SYNC CONTROL ---
app.post('/api/admin/sync/run', async (req, res) => {
  try {
    if (process.env.ENABLE_SYNC_WORKER === 'false') {
      return res.status(400).json({ error: 'Sync worker deshabilitado' });
    }
    const { runManualSync } = require('./workers/syncWorker');
    const result = await runManualSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/sync/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.name as gateway, g.admin_disabled as gateway_disabled,
             COUNT(*) FILTER (WHERE tp.is_active AND NOT tp.admin_disabled) as active_pairs,
             COUNT(*) FILTER (WHERE tp.admin_disabled) as disabled_pairs,
             MAX(tp.last_sync_at) as last_sync
      FROM gateways g
      LEFT JOIN trading_pairs tp ON g.id = tp.gateway_id
      GROUP BY g.id, g.name, g.admin_disabled
    `);
    res.json({
      enabled: process.env.ENABLE_SYNC_WORKER !== 'false',
      interval_minutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '30'),
      gateways: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================
function calculateNextExecution(frequency) {
  const now = new Date();
  switch (frequency) {
    case 'hourly': now.setHours(now.getHours() + 1); break;
    case 'daily': now.setDate(now.getDate() + 1); break;
    case 'weekly': now.setDate(now.getDate() + 7); break;
    case 'monthly': now.setMonth(now.getMonth() + 1); break;
    default: now.setDate(now.getDate() + 1);
  }
  return now;
}

// ============================================
// CRON - DCA Execution
// ============================================
async function checkAndExecuteDCA() {
  try {
    console.log('[CRON] Verificando órdenes DCA...');
    const result = await pool.query(
      `SELECT dca.*, u.wallet_address FROM dca_orders dca
       JOIN users u ON dca.user_id = u.id
       WHERE dca.is_active = true AND dca.next_execution <= NOW()
       ORDER BY dca.next_execution ASC LIMIT 10`
    );
    console.log(`[CRON] ${result.rows.length} órdenes para ejecutar`);
    for (const order of result.rows) {
      await executeDCAOrder(order);
    }
  } catch (error) {
    console.error('[CRON] Error:', error);
  }
}

async function executeDCAOrder(order) {
  console.log(`[DCA] Ejecutando orden ${order.id}...`);
  try {
    const txHash = `klv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO transactions (dca_order_id, user_id, tx_hash, amount, token_from, token_to, status, gas_used)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)`,
      [order.id, order.user_id, txHash, order.amount, order.token_from, order.token_to, Math.random() * 0.001]
    );
    const nextExecution = calculateNextExecution(order.frequency);
    await pool.query('UPDATE dca_orders SET next_execution = $1, updated_at = NOW() WHERE id = $2', [nextExecution, order.id]);
    console.log(`[DCA] ✔ Orden ${order.id} ejecutada`);
  } catch (error) {
    console.error(`[DCA] ✗ Error orden ${order.id}:`, error);
    await pool.query(
      `INSERT INTO transactions (dca_order_id, user_id, amount, token_from, token_to, status, error_message)
       VALUES ($1, $2, $3, $4, $5, 'failed', $6)`,
      [order.id, order.user_id, order.amount, order.token_from, order.token_to, error.message]
    );
  }
}

cron.schedule('0 * * * *', checkAndExecuteDCA);
console.log('✔ Cron DCA iniciado (cada hora)');

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log('═══════════════════════════════════════');
  console.log(`✔ Servidor en puerto ${PORT}`);
  console.log(`✔ Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✔ Admin API: ${process.env.ADMIN_API_KEY ? 'protegida' : '⚠ SIN PROTEGER'}`);

  try {
    await pool.query('SELECT NOW()');
    console.log('✔ Conectado a PostgreSQL');
  } catch (error) {
    console.error('✗ Error PostgreSQL:', error.message);
  }

  if (process.env.ENABLE_SYNC_WORKER !== 'false') {
    const { startSyncWorker } = require('./workers/syncWorker');
    startSyncWorker(pool);
  } else {
    console.log('⏸ Sync Worker deshabilitado');
  }

  console.log('═══════════════════════════════════════');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM recibido. Cerrando...');
  pool.end(() => process.exit(0));
});
