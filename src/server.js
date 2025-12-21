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
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      dbTime: dbCheck.rows[0].now
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

// Cancelar orden DCA (con fee del 1%)
app.delete('/api/dca/orders/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    const { fee_amount, refund_amount } = req.body || {};

    // Obtener la orden antes de cancelar
    const orderResult = await pool.query(
      'SELECT * FROM dca_orders WHERE id = $1',
      [order_id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const order = orderResult.rows[0];

    // Marcar orden como inactiva
    await pool.query(
      'UPDATE dca_orders SET is_active = false, updated_at = NOW() WHERE id = $1',
      [order_id]
    );

    // Crear transacción de cancelación en el historial
    await pool.query(
      `INSERT INTO transactions 
       (dca_order_id, user_id, amount, token_from, token_to, status, error_message, executed_at) 
       VALUES ($1, $2, $3, $4, $5, 'cancelled', $6, NOW())`,
      [
        order.id,
        order.user_id,
        order.amount,
        order.token_from,
        order.token_to,
        `Cancelación manual. Fee (1%): ${fee_amount || '0'} ${order.token_from}. Devolución: ${refund_amount || order.amount} ${order.token_from}`
      ]
    );

    console.log('[DCA] Orden cancelada:', order_id, '- Fee:', fee_amount);

    res.json({
      success: true,
      message: 'Orden cancelada',
      fee: fee_amount,
      refund: refund_amount
    });
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
      `SELECT t.* 
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE u.wallet_address = $1
       ORDER BY t.executed_at DESC
       LIMIT 50`,
      [wallet_address]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo transacciones:', error);
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
      return res.json({
        total_dca_orders: 0,
        active_orders: 0,
        total_transactions: 0,
        successful_transactions: 0,
        total_volume: 0
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ============================================
// ============================================
// ADMIN API - TOKENS
// ============================================
// ============================================

// GET /api/admin/tokens - Listar todos los tokens
app.get('/api/admin/tokens', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tokens ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({ error: 'Error al obtener tokens' });
  }
});

// GET /api/admin/tokens/:id - Obtener un token
app.get('/api/admin/tokens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM tokens WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Token no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching token:', error);
    res.status(500).json({ error: 'Error al obtener token' });
  }
});

// POST /api/admin/tokens - Crear un token
app.post('/api/admin/tokens', async (req, res) => {
  try {
    const { symbol, name, logo_url, decimals, contract_address, is_active } = req.body;
    
    if (!symbol || !name) {
      return res.status(400).json({ error: 'Símbolo y nombre son requeridos' });
    }
    
    // Verificar si ya existe
    const existing = await pool.query(
      'SELECT id FROM tokens WHERE UPPER(symbol) = UPPER($1)',
      [symbol]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un token con ese símbolo' });
    }
    
    const result = await pool.query(
      `INSERT INTO tokens (symbol, name, logo_url, decimals, contract_address, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [symbol.toUpperCase(), name, logo_url, decimals || 6, contract_address, is_active !== false]
    );
    
    console.log('[ADMIN] Token creado:', result.rows[0].symbol);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating token:', error);
    res.status(500).json({ error: 'Error al crear token' });
  }
});

// PUT /api/admin/tokens/:id - Actualizar un token completamente
app.put('/api/admin/tokens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { symbol, name, logo_url, decimals, contract_address, is_active } = req.body;
    
    if (!symbol || !name) {
      return res.status(400).json({ error: 'Símbolo y nombre son requeridos' });
    }
    
    // Verificar si existe otro token con el mismo símbolo
    const existing = await pool.query(
      'SELECT id FROM tokens WHERE UPPER(symbol) = UPPER($1) AND id != $2',
      [symbol, id]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe otro token con ese símbolo' });
    }
    
    const result = await pool.query(
      `UPDATE tokens 
       SET symbol = $1, name = $2, logo_url = $3, decimals = $4, 
           contract_address = $5, is_active = $6
       WHERE id = $7
       RETURNING *`,
      [symbol.toUpperCase(), name, logo_url, decimals || 6, contract_address, is_active, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Token no encontrado' });
    }
    
    console.log('[ADMIN] Token actualizado:', result.rows[0].symbol);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating token:', error);
    res.status(500).json({ error: 'Error al actualizar token' });
  }
});

// PATCH /api/admin/tokens/:id - Actualizar parcialmente
app.patch('/api/admin/tokens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const fields = [];
    const values = [];
    let paramCount = 1;
    
    if (updates.symbol !== undefined) {
      fields.push(`symbol = $${paramCount++}`);
      values.push(updates.symbol.toUpperCase());
    }
    if (updates.name !== undefined) {
      fields.push(`name = $${paramCount++}`);
      values.push(updates.name);
    }
    if (updates.logo_url !== undefined) {
      fields.push(`logo_url = $${paramCount++}`);
      values.push(updates.logo_url);
    }
    if (updates.decimals !== undefined) {
      fields.push(`decimals = $${paramCount++}`);
      values.push(updates.decimals);
    }
    if (updates.contract_address !== undefined) {
      fields.push(`contract_address = $${paramCount++}`);
      values.push(updates.contract_address);
    }
    if (updates.is_active !== undefined) {
      fields.push(`is_active = $${paramCount++}`);
      values.push(updates.is_active);
    }
    
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(id);
    
    const result = await pool.query(
      `UPDATE tokens SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Token no encontrado' });
    }
    
    console.log('[ADMIN] Token parcheado:', result.rows[0].symbol);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error patching token:', error);
    res.status(500).json({ error: 'Error al actualizar token' });
  }
});

// DELETE /api/admin/tokens/:id - Eliminar un token
app.delete('/api/admin/tokens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar si hay trading pairs usando este token
    const pairsCheck = await pool.query(
      'SELECT id FROM trading_pairs WHERE token_from_id = $1 OR token_to_id = $1',
      [id]
    );
    
    if (pairsCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'No se puede eliminar: hay pares de trading usando este token' 
      });
    }
    
    const result = await pool.query(
      'DELETE FROM tokens WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Token no encontrado' });
    }
    
    console.log('[ADMIN] Token eliminado:', result.rows[0].symbol);
    res.json({ message: 'Token eliminado', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting token:', error);
    res.status(500).json({ error: 'Error al eliminar token' });
  }
});

// ============================================
// ============================================
// ADMIN API - GATEWAYS
// ============================================
// ============================================

// GET /api/admin/gateways - Listar todos los gateways
app.get('/api/admin/gateways', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM gateways ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching gateways:', error);
    res.status(500).json({ error: 'Error al obtener gateways' });
  }
});

// GET /api/admin/gateways/:id - Obtener un gateway
app.get('/api/admin/gateways/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM gateways WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gateway no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching gateway:', error);
    res.status(500).json({ error: 'Error al obtener gateway' });
  }
});

// POST /api/admin/gateways - Crear un gateway
app.post('/api/admin/gateways', async (req, res) => {
  try {
    const { name, slug, logo_url, api_url, fee_percentage, is_active } = req.body;
    
    if (!name || !slug) {
      return res.status(400).json({ error: 'Nombre y slug son requeridos' });
    }
    
    // Verificar si ya existe
    const existing = await pool.query(
      'SELECT id FROM gateways WHERE LOWER(slug) = LOWER($1)',
      [slug]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un gateway con ese slug' });
    }
    
    const result = await pool.query(
      `INSERT INTO gateways (name, slug, logo_url, api_url, fee_percentage, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, slug.toLowerCase(), logo_url, api_url, fee_percentage || 0.3, is_active !== false]
    );
    
    console.log('[ADMIN] Gateway creado:', result.rows[0].name);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating gateway:', error);
    res.status(500).json({ error: 'Error al crear gateway' });
  }
});

// PUT /api/admin/gateways/:id - Actualizar un gateway completamente
app.put('/api/admin/gateways/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, logo_url, api_url, fee_percentage, is_active } = req.body;
    
    if (!name || !slug) {
      return res.status(400).json({ error: 'Nombre y slug son requeridos' });
    }
    
    // Verificar si existe otro gateway con el mismo slug
    const existing = await pool.query(
      'SELECT id FROM gateways WHERE LOWER(slug) = LOWER($1) AND id != $2',
      [slug, id]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe otro gateway con ese slug' });
    }
    
    const result = await pool.query(
      `UPDATE gateways 
       SET name = $1, slug = $2, logo_url = $3, api_url = $4, 
           fee_percentage = $5, is_active = $6
       WHERE id = $7
       RETURNING *`,
      [name, slug.toLowerCase(), logo_url, api_url, fee_percentage || 0.3, is_active, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gateway no encontrado' });
    }
    
    console.log('[ADMIN] Gateway actualizado:', result.rows[0].name);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating gateway:', error);
    res.status(500).json({ error: 'Error al actualizar gateway' });
  }
});

// PATCH /api/admin/gateways/:id - Actualizar parcialmente
app.patch('/api/admin/gateways/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const fields = [];
    const values = [];
    let paramCount = 1;
    
    if (updates.name !== undefined) {
      fields.push(`name = $${paramCount++}`);
      values.push(updates.name);
    }
    if (updates.slug !== undefined) {
      fields.push(`slug = $${paramCount++}`);
      values.push(updates.slug.toLowerCase());
    }
    if (updates.logo_url !== undefined) {
      fields.push(`logo_url = $${paramCount++}`);
      values.push(updates.logo_url);
    }
    if (updates.api_url !== undefined) {
      fields.push(`api_url = $${paramCount++}`);
      values.push(updates.api_url);
    }
    if (updates.fee_percentage !== undefined) {
      fields.push(`fee_percentage = $${paramCount++}`);
      values.push(updates.fee_percentage);
    }
    if (updates.is_active !== undefined) {
      fields.push(`is_active = $${paramCount++}`);
      values.push(updates.is_active);
    }
    
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(id);
    
    const result = await pool.query(
      `UPDATE gateways SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gateway no encontrado' });
    }
    
    console.log('[ADMIN] Gateway parcheado:', result.rows[0].name);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error patching gateway:', error);
    res.status(500).json({ error: 'Error al actualizar gateway' });
  }
});

// DELETE /api/admin/gateways/:id - Eliminar un gateway
app.delete('/api/admin/gateways/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar si hay trading pairs usando este gateway
    const pairsCheck = await pool.query(
      'SELECT id FROM trading_pairs WHERE gateway_id = $1',
      [id]
    );
    
    if (pairsCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'No se puede eliminar: hay pares de trading usando este gateway' 
      });
    }
    
    const result = await pool.query(
      'DELETE FROM gateways WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gateway no encontrado' });
    }
    
    console.log('[ADMIN] Gateway eliminado:', result.rows[0].name);
    res.json({ message: 'Gateway eliminado', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting gateway:', error);
    res.status(500).json({ error: 'Error al eliminar gateway' });
  }
});

// ============================================
// ============================================
// ADMIN API - TRADING PAIRS
// ============================================
// ============================================

// GET /api/admin/trading-pairs - Listar todos los pares
app.get('/api/admin/trading-pairs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tp.*, 
              tf.symbol as token_from_symbol, tf.name as token_from_name,
              tt.symbol as token_to_symbol, tt.name as token_to_name,
              g.name as gateway_name, g.slug as gateway_slug
       FROM trading_pairs tp
       LEFT JOIN tokens tf ON tp.token_from_id = tf.id
       LEFT JOIN tokens tt ON tp.token_to_id = tt.id
       LEFT JOIN gateways g ON tp.gateway_id = g.id
       ORDER BY tp.id ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trading pairs:', error);
    res.status(500).json({ error: 'Error al obtener pares de trading' });
  }
});

// GET /api/admin/trading-pairs/:id - Obtener un par
app.get('/api/admin/trading-pairs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT tp.*, 
              tf.symbol as token_from_symbol, tf.name as token_from_name,
              tt.symbol as token_to_symbol, tt.name as token_to_name,
              g.name as gateway_name
       FROM trading_pairs tp
       LEFT JOIN tokens tf ON tp.token_from_id = tf.id
       LEFT JOIN tokens tt ON tp.token_to_id = tt.id
       LEFT JOIN gateways g ON tp.gateway_id = g.id
       WHERE tp.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Par de trading no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching trading pair:', error);
    res.status(500).json({ error: 'Error al obtener par de trading' });
  }
});

// POST /api/admin/trading-pairs - Crear un par
app.post('/api/admin/trading-pairs', async (req, res) => {
  try {
    const { token_from_id, token_to_id, gateway_id, is_active, min_amount, max_amount } = req.body;
    
    if (!token_from_id || !token_to_id || !gateway_id) {
      return res.status(400).json({ error: 'Token origen, destino y gateway son requeridos' });
    }
    
    if (token_from_id === token_to_id) {
      return res.status(400).json({ error: 'Los tokens deben ser diferentes' });
    }
    
    // Verificar si ya existe este par
    const existing = await pool.query(
      `SELECT id FROM trading_pairs 
       WHERE token_from_id = $1 AND token_to_id = $2 AND gateway_id = $3`,
      [token_from_id, token_to_id, gateway_id]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe este par de trading con el mismo gateway' });
    }
    
    // Verificar que existan los tokens y el gateway
    const tokenFromCheck = await pool.query('SELECT id FROM tokens WHERE id = $1', [token_from_id]);
    const tokenToCheck = await pool.query('SELECT id FROM tokens WHERE id = $1', [token_to_id]);
    const gatewayCheck = await pool.query('SELECT id FROM gateways WHERE id = $1', [gateway_id]);
    
    if (tokenFromCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Token de origen no existe' });
    }
    if (tokenToCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Token de destino no existe' });
    }
    if (gatewayCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Gateway no existe' });
    }
    
    const result = await pool.query(
      `INSERT INTO trading_pairs (token_from_id, token_to_id, gateway_id, is_active, min_amount, max_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [token_from_id, token_to_id, gateway_id, is_active !== false, min_amount || 1, max_amount || 100000]
    );
    
    console.log('[ADMIN] Par de trading creado:', result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating trading pair:', error);
    res.status(500).json({ error: 'Error al crear par de trading' });
  }
});

// PUT /api/admin/trading-pairs/:id - Actualizar un par completamente
app.put('/api/admin/trading-pairs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { token_from_id, token_to_id, gateway_id, is_active, min_amount, max_amount } = req.body;
    
    if (!token_from_id || !token_to_id || !gateway_id) {
      return res.status(400).json({ error: 'Token origen, destino y gateway son requeridos' });
    }
    
    if (token_from_id === token_to_id) {
      return res.status(400).json({ error: 'Los tokens deben ser diferentes' });
    }
    
    // Verificar si ya existe otro par igual
    const existing = await pool.query(
      `SELECT id FROM trading_pairs 
       WHERE token_from_id = $1 AND token_to_id = $2 AND gateway_id = $3 AND id != $4`,
      [token_from_id, token_to_id, gateway_id, id]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe este par de trading con el mismo gateway' });
    }
    
    const result = await pool.query(
      `UPDATE trading_pairs 
       SET token_from_id = $1, token_to_id = $2, gateway_id = $3, 
           is_active = $4, min_amount = $5, max_amount = $6
       WHERE id = $7
       RETURNING *`,
      [token_from_id, token_to_id, gateway_id, is_active, min_amount || 1, max_amount || 100000, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Par de trading no encontrado' });
    }
    
    console.log('[ADMIN] Par de trading actualizado:', result.rows[0].id);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating trading pair:', error);
    res.status(500).json({ error: 'Error al actualizar par de trading' });
  }
});

// PATCH /api/admin/trading-pairs/:id - Actualizar parcialmente
app.patch('/api/admin/trading-pairs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const fields = [];
    const values = [];
    let paramCount = 1;
    
    if (updates.token_from_id !== undefined) {
      fields.push(`token_from_id = $${paramCount++}`);
      values.push(updates.token_from_id);
    }
    if (updates.token_to_id !== undefined) {
      fields.push(`token_to_id = $${paramCount++}`);
      values.push(updates.token_to_id);
    }
    if (updates.gateway_id !== undefined) {
      fields.push(`gateway_id = $${paramCount++}`);
      values.push(updates.gateway_id);
    }
    if (updates.is_active !== undefined) {
      fields.push(`is_active = $${paramCount++}`);
      values.push(updates.is_active);
    }
    if (updates.min_amount !== undefined) {
      fields.push(`min_amount = $${paramCount++}`);
      values.push(updates.min_amount);
    }
    if (updates.max_amount !== undefined) {
      fields.push(`max_amount = $${paramCount++}`);
      values.push(updates.max_amount);
    }
    
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(id);
    
    const result = await pool.query(
      `UPDATE trading_pairs SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Par de trading no encontrado' });
    }
    
    console.log('[ADMIN] Par de trading parcheado:', result.rows[0].id);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error patching trading pair:', error);
    res.status(500).json({ error: 'Error al actualizar par de trading' });
  }
});

// DELETE /api/admin/trading-pairs/:id - Eliminar un par
app.delete('/api/admin/trading-pairs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM trading_pairs WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Par de trading no encontrado' });
    }
    
    console.log('[ADMIN] Par de trading eliminado:', result.rows[0].id);
    res.json({ message: 'Par de trading eliminado', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting trading pair:', error);
    res.status(500).json({ error: 'Error al eliminar par de trading' });
  }
});

// ============================================
// ============================================
// PUBLIC API - Tokens, Gateways, Pairs (Activos)
// ============================================
// ============================================

// GET /api/tokens/active - Tokens activos (público)
app.get('/api/tokens/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, symbol, name, logo_url, decimals FROM tokens WHERE is_active = true ORDER BY symbol ASC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tokens' });
  }
});

// GET /api/gateways/active - Gateways activos (público)
app.get('/api/gateways/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, slug, logo_url, fee_percentage FROM gateways WHERE is_active = true ORDER BY name ASC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener gateways' });
  }
});

// GET /api/trading-pairs/active - Pares activos (público)
app.get('/api/trading-pairs/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tp.id, tp.min_amount, tp.max_amount,
              tf.id as token_from_id, tf.symbol as token_from_symbol, tf.name as token_from_name, tf.logo_url as token_from_logo,
              tt.id as token_to_id, tt.symbol as token_to_symbol, tt.name as token_to_name, tt.logo_url as token_to_logo,
              g.id as gateway_id, g.name as gateway_name, g.slug as gateway_slug, g.fee_percentage as gateway_fee
       FROM trading_pairs tp
       JOIN tokens tf ON tp.token_from_id = tf.id AND tf.is_active = true
       JOIN tokens tt ON tp.token_to_id = tt.id AND tt.is_active = true
       JOIN gateways g ON tp.gateway_id = g.id AND g.is_active = true
       WHERE tp.is_active = true
       ORDER BY tf.symbol, tt.symbol`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pares de trading' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================
function calculateNextExecution(frequency) {
  const now = new Date();

  switch (frequency) {
    case 'hourly':
      now.setHours(now.getHours() + 1);
      break;
    case 'daily':
      now.setDate(now.getDate() + 1);
      break;
    case 'weekly':
      now.setDate(now.getDate() + 7);
      break;
    case 'monthly':
      now.setMonth(now.getMonth() + 1);
      break;
    default:
      now.setDate(now.getDate() + 1);
  }

  return now;
}

// ============================================
// CRON JOBS - Ejecutar DCA
// ============================================
async function checkAndExecuteDCA() {
  try {
    console.log('[CRON] Verificando órdenes DCA pendientes...');

    // Obtener órdenes que deben ejecutarse
    const result = await pool.query(
      `SELECT dca.*, u.wallet_address 
       FROM dca_orders dca
       JOIN users u ON dca.user_id = u.id
       WHERE dca.is_active = true 
       AND dca.next_execution <= NOW()
       ORDER BY dca.next_execution ASC
       LIMIT 10`
    );

    const orders = result.rows;
    console.log(`[CRON] Encontradas ${orders.length} órdenes para ejecutar`);

    for (const order of orders) {
      await executeDCAOrder(order);
    }

  } catch (error) {
    console.error('[CRON] Error en checkAndExecuteDCA:', error);
  }
}

async function executeDCAOrder(order) {
  console.log(`[DCA] Ejecutando orden ${order.id}...`);

  try {
    // TODO: Aquí iría la integración real con Klever Blockchain
    // Por ahora simulamos la ejecución

    const txHash = `klv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const gasUsed = Math.random() * 0.001;

    // Guardar transacción exitosa
    await pool.query(
      `INSERT INTO transactions 
       (dca_order_id, user_id, tx_hash, amount, token_from, token_to, status, gas_used) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        order.id,
        order.user_id,
        txHash,
        order.amount,
        order.token_from,
        order.token_to,
        'completed',
        gasUsed
      ]
    );

    // Actualizar próxima ejecución
    const nextExecution = calculateNextExecution(order.frequency);
    await pool.query(
      'UPDATE dca_orders SET next_execution = $1, updated_at = NOW() WHERE id = $2',
      [nextExecution, order.id]
    );

    console.log(`[DCA] ✔ Orden ${order.id} ejecutada. TX: ${txHash}`);

  } catch (error) {
    console.error(`[DCA] ✗ Error ejecutando orden ${order.id}:`, error);

    // Guardar transacción fallida
    await pool.query(
      `INSERT INTO transactions 
       (dca_order_id, user_id, amount, token_from, token_to, status, error_message) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        order.id,
        order.user_id,
        order.amount,
        order.token_from,
        order.token_to,
        'failed',
        error.message
      ]
    );
  }
}

// Cron: Verificar cada hora
cron.schedule('0 * * * *', checkAndExecuteDCA);
console.log('✔ Cron jobs iniciados');

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log('═══════════════════════════════════════');
  console.log(`✔ Servidor corriendo en puerto ${PORT}`);
  console.log(`✔ Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✔ CORS configurado para: ${process.env.CORS_ORIGIN}`);

  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✔ Conectado a PostgreSQL');
    console.log(`✔ Hora del servidor DB: ${result.rows[0].now}`);
  } catch (error) {
    console.error('✗ Error conectando a PostgreSQL:', error.message);
  }

  console.log('═══════════════════════════════════════');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido. Cerrando servidor...');
  pool.end(() => {
    console.log('Pool de PostgreSQL cerrado');
    process.exit(0);
  });
});
