const pool = require('../config/database');

/**
 * Modelo de Usuario
 */
const User = {
  // Crear o actualizar usuario
  async findOrCreate(walletAddress) {
    const query = `
      INSERT INTO users (wallet_address) 
      VALUES ($1) 
      ON CONFLICT (wallet_address) 
      DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;
    const result = await pool.query(query, [walletAddress]);
    return result.rows[0];
  },

  // Buscar por wallet
  async findByWallet(walletAddress) {
    const query = 'SELECT * FROM users WHERE wallet_address = $1';
    const result = await pool.query(query, [walletAddress]);
    return result.rows[0];
  },

  // Obtener estadísticas
  async getStats(walletAddress) {
    const query = 'SELECT * FROM user_stats WHERE wallet_address = $1';
    const result = await pool.query(query, [walletAddress]);
    return result.rows[0];
  }
};

/**
 * Modelo de Orden DCA
 */
const DCAOrder = {
  // Crear nueva orden
  async create(userId, tokenFrom, tokenTo, amount, frequency, nextExecution) {
    const query = `
      INSERT INTO dca_orders 
      (user_id, token_from, token_to, amount, frequency, next_execution) 
      VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *
    `;
    const result = await pool.query(query, [
      userId, tokenFrom, tokenTo, amount, frequency, nextExecution
    ]);
    return result.rows[0];
  },

  // Obtener órdenes activas de un usuario
  async findByUser(userId, activeOnly = false) {
    let query = `
      SELECT * FROM dca_orders 
      WHERE user_id = $1
    `;
    if (activeOnly) {
      query += ' AND is_active = true';
    }
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, [userId]);
    return result.rows;
  },

  // Obtener órdenes pendientes de ejecución
  async getPendingOrders(limit = 10) {
    const query = `
      SELECT do.*, u.wallet_address 
      FROM dca_orders do
      JOIN users u ON do.user_id = u.id
      WHERE do.is_active = true 
      AND do.next_execution <= NOW()
      ORDER BY do.next_execution ASC
      LIMIT $1
    `;
    const result = await pool.query(query, [limit]);
    return result.rows;
  },

  // Actualizar próxima ejecución
  async updateNextExecution(orderId, nextExecution) {
    const query = `
      UPDATE dca_orders 
      SET next_execution = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `;
    const result = await pool.query(query, [nextExecution, orderId]);
    return result.rows[0];
  },

  // Cancelar orden
  async cancel(orderId) {
    const query = `
      UPDATE dca_orders 
      SET is_active = false, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [orderId]);
    return result.rows[0];
  }
};

/**
 * Modelo de Transacción
 */
const Transaction = {
  // Crear nueva transacción
  async create(dcaOrderId, userId, txHash, amount, tokenFrom, tokenTo, status, gasUsed, errorMessage = null) {
    const query = `
      INSERT INTO transactions 
      (dca_order_id, user_id, tx_hash, amount, token_from, token_to, status, gas_used, error_message) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    const result = await pool.query(query, [
      dcaOrderId, userId, txHash, amount, tokenFrom, tokenTo, status, gasUsed, errorMessage
    ]);
    return result.rows[0];
  },

  // Obtener transacciones de un usuario
  async findByUser(userId, limit = 50) {
    const query = `
      SELECT * FROM transactions 
      WHERE user_id = $1
      ORDER BY executed_at DESC
      LIMIT $2
    `;
    const result = await pool.query(query, [userId, limit]);
    return result.rows;
  },

  // Obtener transacciones de una orden
  async findByOrder(dcaOrderId) {
    const query = `
      SELECT * FROM transactions 
      WHERE dca_order_id = $1
      ORDER BY executed_at DESC
    `;
    const result = await pool.query(query, [dcaOrderId]);
    return result.rows;
  },

  // Estadísticas de transacciones
  async getStats(userId) {
    const query = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_volume,
        SUM(CASE WHEN status = 'completed' THEN gas_used ELSE 0 END) as total_gas
      FROM transactions 
      WHERE user_id = $1
    `;
    const result = await pool.query(query, [userId]);
    return result.rows[0];
  }
};

module.exports = {
  User,
  DCAOrder,
  Transaction
};
