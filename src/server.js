require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');

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
pool.on('remove', () => console.log('Cliente removido del pool'));

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: [
    process.env.CORS_ORIGIN,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json());

// Logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW()');
    
    // Check sync status
    const syncStatus = await pool.query(
      `SELECT COUNT(*) as active_pairs, MAX(last_sync_at) as last_sync 
       FROM trading_pairs WHERE is_active = true`
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
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// ============================================
// USERS API
// ============================================
app.post('/api/users', async (req, res) => {
  try {
    const { wallet_address } = req.body;
    if (!wallet_address) {
      return res.status(400).json({ error: 'wallet_address es requerido' });
    }

    const result = await pool.query(
      `INSERT INTO users (wallet_address) 
       VALUES ($1) 
       ON CONFLICT (wallet_address) 
       DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [wallet_address]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// ============================================
// DCA ORDERS API
// ============================================

// Crear orden DCA
app.post('/api/dca/create', async (req, res) => {
  try {
    const { wallet_address, token_from, token_to, amount, frequency } = req.body;

    if (!wallet_address || !token_from || !token_to || !amount || !frequency) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const minAmount = parseFloat(process.env.MIN_TRANSACTION_AMOUNT || 1);
    const maxAmount = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || 10000);

    if (amount < minAmount || amount > maxAmount) {
      return res.status(400).json({
        error: `Monto debe estar entre ${minAmount} y ${maxAmount}`
      });
    }

    // Obtener o crear usuario
    const userResult = await pool.query(
      `INSERT INTO users (wallet_address) 
       VALUES ($1) 
       ON CONFLICT (wallet_address) 
       DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [wallet_address]
    );

    const userId = userResult.rows[0].id;
    const nextExecution = calculateNextExecution(frequency);

    // Crear orden DCA
    const orderResult = await pool.query(
      `INSERT INTO dca_orders 
       (user_id, token_from, token_to, amount, frequency, next_execution) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [userId, token_from, token_to, amount, frequency, nextExecution]
    );

    console.log('[DCA] Nueva orden creada:', orderResult.rows[0].id);
    res.json(orderResult.rows[0]);

  } catch (error) {
    console.error('Error creando orden DCA:', error);
    res.status(500).json({ error: 'Error al crear orden DCA' });
  }
});

// Obtener órdenes de un usuario
app.get('/api/dca/orders/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;

    const result = await pool.query(
      `SELECT dca.* 
       FROM dca_orders dca
       JOIN users u ON dca.user_id = u.id
       WHERE u.wallet_address = $1
       ORDER BY dca.created_at DESC`,
      [wallet_address]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo órdenes:', error);
    res.status(500).json({ error: 'Error al obtener órdenes' });
  }
});

// Cancelar orden DCA
app.delete('/api/dca/orders/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    const { fee_amount, refund_amount } = req.body || {};

    const orderResult = await pool.query(
      'SELECT * FROM dca_orders WHERE id = $1',
      [order_id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const order = orderResult.rows[0];

    await pool.query(
      'UPDATE dca_orders SET is_active = false, updated_at = NOW() WHERE id = $1',
      [order_id]
    );

    await pool.query(
      `INSERT INTO transactions 
       (dca_order_id, user_id, amount, token_from, token_to, status, error_message, executed_at) 
       VALUES ($1, $2, $3, $4, $5, 'cancelled', $6, NOW())`,
      [order.id, order.user_id, order.amount, order.token_from, order.token_to,
       `Cancelación manual. Fee: ${fee_amount || '0'}. Refund: ${refund_amount || order.amount}`]
    );

    console.log('[DCA] Orden cancelada:', order_id);
    res.json({ success: true, message: 'Orden cancelada', fee: fee_amount, refund: refund_amount });
  } catch (error) {
    console.error('Error cancelando orden:', error);
    res.status(500).json({ error: 'Error al cancelar orden' });
  }
});

// ============================================
// TRANSACTIONS API
// ============================================
app.get('/api/transactions/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;
    const result = await pool.query(
      `SELECT t.* FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE u.wallet_address = $1
       ORDER BY t.executed_at DESC LIMIT 50`,
      [wallet_address]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

// ============================================
// STATS API
// ============================================
app.get('/api/stats/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;
    const result = await pool.query(
      'SELECT * FROM user_stats WHERE wallet_address = $1',
      [wallet_address]
    );
    if (result.rows.length === 0) {
      return res.json({ total_dca_orders: 0, active_orders: 0, total_transactions: 0 });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ============================================
// ADMIN API - TOKENS
// ============================================
app.get('/api/admin/tokens', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tokens ORDER BY id ASC');
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
    
    const existing = await pool.query('SELECT id FROM tokens WHERE UPPER(symbol) = UPPER($1)', [symbol]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Token ya existe' });
    
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

app.delete('/api/admin/tokens/:id', async (req, res) => {
  try {
    const pairsCheck = await pool.query(
      'SELECT id FROM trading_pairs WHERE token_from_id = $1 OR token_to_id = $1', [req.params.id]
    );
    if (pairsCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Token en uso por trading pairs' });
    }
    const result = await pool.query('DELETE FROM tokens WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token no encontrado' });
    res.json({ message: 'Token eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar token' });
  }
});

// ============================================
// ADMIN API - GATEWAYS
// ============================================
app.get('/api/admin/gateways', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM gateways ORDER BY id ASC');
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

app.delete('/api/admin/gateways/:id', async (req, res) => {
  try {
    const pairsCheck = await pool.query('SELECT id FROM trading_pairs WHERE gateway_id = $1', [req.params.id]);
    if (pairsCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Gateway en uso por trading pairs' });
    }
    const result = await pool.query('DELETE FROM gateways WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gateway no encontrado' });
    res.json({ message: 'Gateway eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar gateway' });
  }
});

// ============================================
// ADMIN API - TRADING PAIRS
// ============================================
app.get('/api/admin/trading-pairs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tp.*, tf.symbol as token_from_symbol, tt.symbol as token_to_symbol, g.name as gateway_name
       FROM trading_pairs tp
       LEFT JOIN tokens tf ON tp.token_from_id = tf.id
       LEFT JOIN tokens tt ON tp.token_to_id = tt.id
       LEFT JOIN gateways g ON tp.gateway_id = g.id
       ORDER BY tp.id ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pares' });
  }
});

app.post('/api/admin/trading-pairs', async (req, res) => {
  try {
    const { token_from_id, token_to_id, gateway_id, is_active, min_amount, max_amount } = req.body;
    if (!token_from_id || !token_to_id || !gateway_id) {
      return res.status(400).json({ error: 'Tokens y gateway requeridos' });
    }
    const result = await pool.query(
      `INSERT INTO trading_pairs (token_from_id, token_to_id, gateway_id, is_active, min_amount, max_amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [token_from_id, token_to_id, gateway_id, is_active !== false, min_amount || 1, max_amount || 100000]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear par' });
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

// ============================================
// ADMIN API - SYNC CONTROL
// ============================================
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
      SELECT g.name as gateway, 
             COUNT(*) FILTER (WHERE tp.is_active) as active_pairs,
             MAX(tp.last_sync_at) as last_sync
      FROM gateways g
      LEFT JOIN trading_pairs tp ON g.id = tp.gateway_id
      GROUP BY g.id, g.name
    `);
    res.json({
      enabled: process.env.ENABLE_SYNC_WORKER !== 'false',
      interval_minutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '5'),
      gateways: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PUBLIC API - Active Resources
// ============================================
app.get('/api/tokens/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, symbol, name, logo_url, decimals FROM tokens WHERE is_active = true ORDER BY symbol'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tokens' });
  }
});

app.get('/api/gateways/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, slug, logo_url, fee_percentage FROM gateways WHERE is_active = true ORDER BY name'
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
       WHERE tp.is_active = true AND tf.is_active = true AND tt.is_active = true AND g.is_active = true
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
       WHERE tp.is_active = true
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
      `SELECT tf.symbol as from_symbol, tt.symbol as to_symbol, g.name as gateway, g.fee_percentage as fee,
              tp.reserve0, tp.reserve1,
              CASE WHEN tp.reserve1 > 0 THEN (tp.reserve0::numeric / tp.reserve1::numeric) ELSE 0 END as price,
              tp.last_sync_at
       FROM trading_pairs tp
       JOIN tokens tf ON tp.token_from_id = tf.id
       JOIN tokens tt ON tp.token_to_id = tt.id
       JOIN gateways g ON tp.gateway_id = g.id
       WHERE UPPER(tf.symbol) = UPPER($1) AND UPPER(tt.symbol) = UPPER($2) AND tp.is_active = true
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
    // TODO: Integración real con Klever Blockchain
    const txHash = `klv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    await pool.query(
      `INSERT INTO transactions (dca_order_id, user_id, tx_hash, amount, token_from, token_to, status, gas_used)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)`,
      [order.id, order.user_id, txHash, order.amount, order.token_from, order.token_to, Math.random() * 0.001]
    );
    
    const nextExecution = calculateNextExecution(order.frequency);
    await pool.query('UPDATE dca_orders SET next_execution = $1, updated_at = NOW() WHERE id = $2',
      [nextExecution, order.id]);
    
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

  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✔ Conectado a PostgreSQL');
  } catch (error) {
    console.error('✗ Error PostgreSQL:', error.message);
  }

  // Iniciar Sync Worker
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
