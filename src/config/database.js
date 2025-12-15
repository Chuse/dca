const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false,
  max: 20, // Máximo de conexiones en el pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Event listeners
pool.on('connect', (client) => {
  console.log('Nueva conexión al pool de PostgreSQL');
});

pool.on('error', (err, client) => {
  console.error('Error inesperado en cliente PostgreSQL:', err);
  process.exit(-1);
});

pool.on('remove', () => {
  console.log('Cliente removido del pool');
});

// Test inicial de conexión
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error al conectar a PostgreSQL:', err);
  } else {
    console.log('✓ Pool de PostgreSQL inicializado correctamente');
  }
});

module.exports = pool;
