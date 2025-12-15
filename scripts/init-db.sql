-- Eliminar tablas si existen (¡CUIDADO en producción!)
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS dca_orders CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP VIEW IF EXISTS user_stats;

-- Crear tabla de usuarios
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Crear tabla de órdenes DCA
CREATE TABLE dca_orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_from VARCHAR(10) NOT NULL,
  token_to VARCHAR(10) NOT NULL,
  amount DECIMAL(18, 8) NOT NULL CHECK (amount > 0),
  frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('hourly', 'daily', 'weekly', 'monthly')),
  next_execution TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Crear tabla de transacciones
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  dca_order_id INTEGER REFERENCES dca_orders(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_hash VARCHAR(255) UNIQUE,
  amount DECIMAL(18, 8) NOT NULL,
  token_from VARCHAR(10) NOT NULL,
  token_to VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  gas_used DECIMAL(18, 8),
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT NOW()
);

-- Índices para mejorar performance
CREATE INDEX idx_users_wallet ON users(wallet_address);
CREATE INDEX idx_dca_orders_user_id ON dca_orders(user_id);
CREATE INDEX idx_dca_orders_active ON dca_orders(is_active, next_execution) WHERE is_active = true;
CREATE INDEX idx_dca_orders_next_execution ON dca_orders(next_execution) WHERE is_active = true;
CREATE INDEX idx_transactions_dca_order ON transactions(dca_order_id);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_executed_at ON transactions(executed_at DESC);

-- Vista para estadísticas de usuario
CREATE VIEW user_stats AS
SELECT 
  u.id,
  u.wallet_address,
  COUNT(DISTINCT do.id) as total_dca_orders,
  COUNT(DISTINCT CASE WHEN do.is_active THEN do.id END) as active_orders,
  COUNT(DISTINCT t.id) as total_transactions,
  COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) as successful_transactions,
  COUNT(DISTINCT CASE WHEN t.status = 'failed' THEN t.id END) as failed_transactions,
  SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END) as total_volume,
  SUM(CASE WHEN t.status = 'completed' THEN t.gas_used ELSE 0 END) as total_gas_used,
  MAX(t.executed_at) as last_transaction_at
FROM users u
LEFT JOIN dca_orders do ON u.id = do.user_id
LEFT JOIN transactions t ON u.id = t.user_id
GROUP BY u.id, u.wallet_address;

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_dca_orders_updated_at BEFORE UPDATE ON dca_orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Datos de prueba (opcional)
INSERT INTO users (wallet_address) VALUES 
  ('klv1test1wallet1address1xxxxxxxxxxxx'),
  ('klv1test2wallet2address2xxxxxxxxxxxx');

-- Mensaje de éxito
DO $$
BEGIN
  RAISE NOTICE '✓ Base de datos inicializada correctamente';
  RAISE NOTICE '✓ Tablas creadas: users, dca_orders, transactions';
  RAISE NOTICE '✓ Vista creada: user_stats';
  RAISE NOTICE '✓ Índices y triggers configurados';
END $$;
