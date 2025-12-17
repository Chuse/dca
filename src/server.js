require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const pool = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: [
    process.env.CORS_ORIGIN || 'https://magnificent-biscuit-0bd117.netlify.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true
}));

app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// RUTAS - HEALTH CHECK
// ============================================

app.get('/health', async (req, res) => {
  try {
    // Verificar conexión a DB
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
// RUTAS - DCA API
// ============================================

// Crear nuevo usuario o obtener existente
app.post('/api/users', async (req, res) => {
  try {
    const { wallet_address } = req.body;
    
    if (!wallet_address) {
      return res.status(400).json({ error: 'wallet_address es requerido' });
    }

    // Intentar insertar, si existe devolver el existente
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

// Crear orden DCA
app.post('/api/dca/create', async (req, res) => {
  try {
    const { wallet_address, token_from, token_to, amount, frequency } = req.body;

    // Validaciones
    if (!wallet_address || !token_from || !token_to || !amount || !frequency) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    // Validar monto
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

    // Calcular próxima ejecución
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

// Obtener transacciones de un usuario
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

// Cancelar orden DCA
app.delete('/api/dca/orders/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;

    const result = await pool.query(
      `UPDATE dca_orders 
       SET is_active = false, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [order_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    console.log('[DCA] Orden cancelada:', order_id);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error cancelando orden:', error);
    res.status(500).json({ error: 'Error al cancelar orden' });
  }
});

// Estadísticas del usuario
app.get('/api/stats/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;

    const result = await pool.query(
      `SELECT * FROM user_stats WHERE wallet_address = $1`,
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
// FUNCIONES AUXILIARES
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
      now.setDate(now.getDate() + 1); // Default: daily
  }
  
  return now;
}

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
    // AQUÍ IRÍA LA LÓGICA DE KLEVER
    // Por ahora simulamos la ejecución
    
    // Simular transacción
    const txHash = `simulated_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const gasUsed = Math.random() * 0.001;

    // Guardar transacción
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
      `UPDATE dca_orders 
       SET next_execution = $1, updated_at = NOW()
       WHERE id = $2`,
      [nextExecution, order.id]
    );

    console.log(`[DCA] ✓ Orden ${order.id} ejecutada exitosamente. TX: ${txHash}`);

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

// ============================================
// CRON JOBS
// ============================================

// Verificar órdenes DCA cada hora
cron.schedule('0 * * * *', checkAndExecuteDCA);

// Para testing más rápido, descomenta esto (cada 5 minutos)
// cron.schedule('*/5 * * * *', checkAndExecuteDCA);

console.log('✓ Cron jobs iniciados');

// ============================================
// MANEJO DE ERRORES
// ============================================

app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================

app.listen(PORT, '0.0.0.0', async () => {
  console.log('════════════════════════════════════════');
  console.log(`✓ Servidor corriendo en puerto ${PORT}`);
  console.log(`✓ Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✓ CORS configurado para: ${process.env.CORS_ORIGIN}`);
  
  // Test de conexión a DB
  try {
    const result = await pool.query('SELECT NOW()');
    console.log(`✓ Conectado a PostgreSQL`);
    console.log(`✓ Hora del servidor DB: ${result.rows[0].now}`);
  } catch (error) {
    console.error('✗ Error conectando a PostgreSQL:', error.message);
  }
  
  console.log('════════════════════════════════════════');
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido. Cerrando servidor...');
  pool.end(() => {
    console.log('Pool de PostgreSQL cerrado');
    process.exit(0);
  });
});
