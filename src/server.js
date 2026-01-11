// ============================================
// KLEVERDCA BACKEND - SERVER.JS
// Versión: 2.0
// ============================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================
// CONFIGURACIÓN
// ============================================
const ADMIN_WALLET = 'klv1a03thxgp7nful7stqkdveeypm40zgme7puthp5las655z3nkl4ys3r0ddp';
const SWOPUS_API = 'https://api3.swopus.com';

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Logger middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

app.get('/', (req, res) => {
  res.json({
    name: 'KleverDCA API',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// BASE DE DATOS
// ============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
    console.log('Nueva conexión al pool de PostgreSQL');
});

pool.on('error', (err) => {
    console.error('Error en el pool de PostgreSQL:', err);
});

// Test de conexión
async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        console.log('✔ Conectado a PostgreSQL');
        return true;
    } catch (error) {
        console.error('✖ Error conectando a PostgreSQL:', error.message);
        return false;
    }
}

// ============================================
// RUTAS PRINCIPALES
// ============================================

// Ruta raíz
app.get('/', (req, res) => {
    res.json({
        name: 'KleverDCA API',
        version: '2.0',
        status: 'online',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: '/health',
            api: '/api/*',
            admin: '/api/admin/*'
        }
    });
});

// Health check
app.get('/health', async (req, res) => {
    const dbConnected = await testDatabaseConnection();
    res.json({
        status: 'ok',
        database: dbConnected ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ============================================
// API - USUARIOS Y STATS
// ============================================

// Obtener o crear usuario por wallet
app.get('/api/user/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        
        // Buscar usuario
        let result = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [wallet]
        );
        
        // Si no existe, crearlo
        if (result.rows.length === 0) {
            result = await pool.query(
                'INSERT INTO users (wallet_address) VALUES ($1) RETURNING *',
                [wallet]
            );
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error en /api/user:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stats de usuario
app.get('/api/stats/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM user_stats WHERE wallet_address = $1',
            [wallet]
        );
        
        if (result.rows.length === 0) {
            res.json({
                wallet_address: wallet,
                total_dca_orders: 0,
                active_orders: 0,
                total_transactions: 0,
                successful_transactions: 0,
                total_volume: 0
            });
        } else {
            res.json(result.rows[0]);
        }
    } catch (error) {
        console.error('Error en /api/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API - ÓRDENES DCA
// ============================================

// Listar órdenes de un usuario
app.get('/api/dca/orders/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        
        const result = await pool.query(`
            SELECT o.*, u.wallet_address
            FROM dca_orders o
            JOIN users u ON o.user_id = u.id
            WHERE u.wallet_address = $1
            ORDER BY o.created_at DESC
        `, [wallet]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error en /api/dca/orders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Crear orden DCA
app.post('/api/dca/create', async (req, res) => {
    try {
        const { wallet_address, token_from, token_to, amount, frequency } = req.body;
        
        if (!wallet_address || !token_from || !token_to || !amount) {
            return res.status(400).json({ error: 'Faltan campos requeridos' });
        }
        
        // Obtener o crear usuario
        let userResult = await pool.query(
            'SELECT id FROM users WHERE wallet_address = $1',
            [wallet_address]
        );
        
        if (userResult.rows.length === 0) {
            userResult = await pool.query(
                'INSERT INTO users (wallet_address) VALUES ($1) RETURNING id',
                [wallet_address]
            );
        }
        
        const userId = userResult.rows[0].id;
        
        // Calcular próxima ejecución
        const nextExecution = calculateNextExecution(frequency);
        
        // Crear orden
        const result = await pool.query(`
            INSERT INTO dca_orders (user_id, token_from, token_to, amount, frequency, next_execution, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, true)
            RETURNING *
        `, [userId, token_from, token_to, amount, frequency, nextExecution]);
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error en /api/dca/create:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cancelar orden DCA
app.delete('/api/dca/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(`
            UPDATE dca_orders 
            SET is_active = false, updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Orden no encontrada' });
        }
        
        res.json({ message: 'Orden cancelada', order: result.rows[0] });
    } catch (error) {
        console.error('Error cancelando orden:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API - TRANSACCIONES
// ============================================

// Listar transacciones de un usuario
app.get('/api/transactions/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        
        const result = await pool.query(`
            SELECT t.*, u.wallet_address
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE u.wallet_address = $1
            ORDER BY t.executed_at DESC
            LIMIT 50
        `, [wallet]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error en /api/transactions:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API - TOKENS Y PARES (público)
// ============================================

// Listar tokens activos
app.get('/api/tokens', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, symbol, name, logo_url, decimals, price_usd
            FROM tokens 
            WHERE is_active = true AND admin_disabled = false
            ORDER BY symbol
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error en /api/tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// Listar pares de trading activos
app.get('/api/trading-pairs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                tp.id,
                tf.symbol as token_from_symbol,
                tf.name as token_from_name,
                tt.symbol as token_to_symbol,
                tt.name as token_to_name,
                g.name as gateway_name,
                tp.min_amount,
                tp.max_amount
            FROM trading_pairs tp
            JOIN tokens tf ON tp.token_from_id = tf.id
            JOIN tokens tt ON tp.token_to_id = tt.id
            JOIN gateways g ON tp.gateway_id = g.id
            WHERE tp.is_active = true AND tp.admin_disabled = false
            ORDER BY tf.symbol, tt.symbol
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error en /api/trading-pairs:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API ADMIN - TOKENS
// ============================================

app.get('/api/admin/tokens', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tokens ORDER BY symbol');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/tokens', async (req, res) => {
    try {
        const { symbol, name, decimals, logo_url, contract_address, price_usd, is_active } = req.body;
        
        const result = await pool.query(`
            INSERT INTO tokens (symbol, name, decimals, logo_url, contract_address, price_usd, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [symbol, name, decimals || 6, logo_url, contract_address, price_usd || 0, is_active !== false]);
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/tokens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { symbol, name, decimals, logo_url, contract_address, price_usd, is_active } = req.body;
        
        const result = await pool.query(`
            UPDATE tokens 
            SET symbol = COALESCE($1, symbol),
                name = COALESCE($2, name),
                decimals = COALESCE($3, decimals),
                logo_url = COALESCE($4, logo_url),
                contract_address = COALESCE($5, contract_address),
                price_usd = COALESCE($6, price_usd),
                is_active = COALESCE($7, is_active)
            WHERE id = $8
            RETURNING *
        `, [symbol, name, decimals, logo_url, contract_address, price_usd, is_active, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Token no encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/tokens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM tokens WHERE id = $1', [id]);
        res.json({ message: 'Token eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API ADMIN - GATEWAYS
// ============================================

app.get('/api/admin/gateways', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM gateways ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/gateways', async (req, res) => {
    try {
        const { name, slug, logo_url, api_url, fee_percentage, is_active } = req.body;
        
        const result = await pool.query(`
            INSERT INTO gateways (name, slug, logo_url, api_url, fee_percentage, is_active)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [name, slug, logo_url, api_url, fee_percentage || 0.30, is_active !== false]);
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/gateways/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, slug, logo_url, api_url, fee_percentage, is_active } = req.body;
        
        const result = await pool.query(`
            UPDATE gateways 
            SET name = COALESCE($1, name),
                slug = COALESCE($2, slug),
                logo_url = COALESCE($3, logo_url),
                api_url = COALESCE($4, api_url),
                fee_percentage = COALESCE($5, fee_percentage),
                is_active = COALESCE($6, is_active)
            WHERE id = $7
            RETURNING *
        `, [name, slug, logo_url, api_url, fee_percentage, is_active, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Gateway no encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/gateways/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM gateways WHERE id = $1', [id]);
        res.json({ message: 'Gateway eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API ADMIN - TRADING PAIRS
// ============================================

app.get('/api/admin/trading-pairs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                tp.*,
                tf.symbol as token_from_symbol,
                tf.name as token_from_name,
                tt.symbol as token_to_symbol,
                tt.name as token_to_name,
                g.name as gateway_name
            FROM trading_pairs tp
            LEFT JOIN tokens tf ON tp.token_from_id = tf.id
            LEFT JOIN tokens tt ON tp.token_to_id = tt.id
            LEFT JOIN gateways g ON tp.gateway_id = g.id
            ORDER BY tf.symbol, tt.symbol
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/trading-pairs', async (req, res) => {
    try {
        const { token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, min_amount, max_amount, is_active } = req.body;
        
        const result = await pool.query(`
            INSERT INTO trading_pairs (token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, min_amount, max_amount, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [token_from_id, token_to_id, gateway_id, pair_id_external, reserve0 || 0, reserve1 || 0, min_amount || 1, max_amount || 100000, is_active !== false]);
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/trading-pairs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, min_amount, max_amount, is_active } = req.body;
        
        const result = await pool.query(`
            UPDATE trading_pairs 
            SET token_from_id = COALESCE($1, token_from_id),
                token_to_id = COALESCE($2, token_to_id),
                gateway_id = COALESCE($3, gateway_id),
                pair_id_external = COALESCE($4, pair_id_external),
                reserve0 = COALESCE($5, reserve0),
                reserve1 = COALESCE($6, reserve1),
                min_amount = COALESCE($7, min_amount),
                max_amount = COALESCE($8, max_amount),
                is_active = COALESCE($9, is_active)
            WHERE id = $10
            RETURNING *
        `, [token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, min_amount, max_amount, is_active, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Par no encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/trading-pairs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM trading_pairs WHERE id = $1', [id]);
        res.json({ message: 'Par eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API ADMIN - ORDERS
// ============================================

app.get('/api/admin/orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.*, u.wallet_address
            FROM dca_orders o
            JOIN users u ON o.user_id = u.id
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        
        const result = await pool.query(`
            UPDATE dca_orders 
            SET is_active = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING *
        `, [is_active, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Orden no encontrada' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API ADMIN - TRANSACTIONS
// ============================================

app.get('/api/admin/transactions', async (req, res) => {
    try {
        const { status, limit } = req.query;
        
        let query = `
            SELECT t.*, u.wallet_address
            FROM transactions t
            JOIN users u ON t.user_id = u.id
        `;
        const params = [];
        
        if (status && status !== 'all') {
            query += ' WHERE t.status = $1';
            params.push(status);
        }
        
        query += ' ORDER BY t.executed_at DESC';
        
        if (limit) {
            query += ` LIMIT ${parseInt(limit)}`;
        }
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/transactions', async (req, res) => {
    try {
        const { dca_order_id, user_id, tx_hash, amount, token_from, token_to, amount_received, price_at_execution, status, error_message } = req.body;
        
        const result = await pool.query(`
            INSERT INTO transactions (dca_order_id, user_id, tx_hash, amount, token_from, token_to, amount_received, price_at_execution, status, error_message)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [dca_order_id, user_id, tx_hash, amount, token_from, token_to, amount_received, price_at_execution, status || 'pending', error_message]);
        
        // Actualizar totales de la orden si existe
        if (dca_order_id && status === 'completed') {
            await pool.query(`
                UPDATE dca_orders 
                SET total_invested = total_invested + $1,
                    total_received = total_received + $2
                WHERE id = $3
            `, [amount, amount_received || 0, dca_order_id]);
        }
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API ADMIN - USERS
// ============================================

app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM user_stats ORDER BY total_volume DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SYNC WORKER - SWOPUS
// ============================================

let tokenCache = new Map();

async function syncWithSwopus() {
    console.log('[SYNC] Iniciando sincronización con Swopus...');
    
    try {
        // Obtener gateway de Swopus
        const gatewayResult = await pool.query(
            "SELECT * FROM gateways WHERE slug = 'swopus' AND is_active = true"
        );
        
        if (gatewayResult.rows.length === 0) {
            console.log('[SYNC] Gateway Swopus no encontrado o inactivo');
            return;
        }
        
        const gateway = gatewayResult.rows[0];
        console.log('[SYNC] ══════════════════════════════════════');
        console.log(`[SYNC] Gateway: ${gateway.name} (ID: ${gateway.id})`);
        
        // Consultar API de Swopus
        console.log('[SYNC] Consultando API de Swopus...');
        const response = await fetch(`${SWOPUS_API}/pairs`);
        
        if (!response.ok) {
            throw new Error(`API respondió con status ${response.status}`);
        }
        
        const data = await response.json();
        
        // Procesar tokens únicos
        const tokens = new Set();
        const pairs = [];
        
        if (data.pairs) {
            for (const pair of data.pairs) {
                if (pair.token0 && pair.token1) {
                    tokens.add(JSON.stringify({ 
                        symbol: pair.token0.symbol, 
                        name: pair.token0.name || pair.token0.symbol,
                        contract: pair.token0.address || pair.token0.symbol
                    }));
                    tokens.add(JSON.stringify({ 
                        symbol: pair.token1.symbol, 
                        name: pair.token1.name || pair.token1.symbol,
                        contract: pair.token1.address || pair.token1.symbol
                    }));
                    
                    // Solo pares con liquidez
                    if (pair.reserve0 > 0 && pair.reserve1 > 0) {
                        pairs.push(pair);
                    }
                }
            }
        }
        
        const tokenArray = Array.from(tokens).map(t => JSON.parse(t));
        console.log(`[SYNC] Recibidos: ${tokenArray.length} tokens, ${data.pairs?.length || 0} pares`);
        console.log(`[SYNC] Pares con liquidez válida: ${pairs.length}`);
        
        // Sincronizar tokens
        console.log('[SYNC] Procesando tokens...');
        for (const token of tokenArray) {
            try {
                await pool.query(`
                    INSERT INTO tokens (symbol, name, contract_address, is_active)
                    VALUES ($1, $2, $3, true)
                    ON CONFLICT (contract_address) 
                    DO UPDATE SET name = EXCLUDED.name, price_updated_at = NOW()
                `, [token.symbol, token.name, token.contract]);
            } catch (err) {
                // Ignorar errores de duplicado
            }
        }
        
        // Actualizar cache de tokens
        const allTokens = await pool.query('SELECT id, symbol, contract_address FROM tokens');
        tokenCache.clear();
        for (const t of allTokens.rows) {
            tokenCache.set(t.symbol, t.id);
            tokenCache.set(t.contract_address, t.id);
        }
        console.log(`[SYNC] Tokens en cache: ${tokenCache.size}`);
        
        // Sincronizar pares
        console.log('[SYNC] Procesando pares...');
        let updatedPairs = 0;
        let skippedPairs = 0;
        let deactivatedPairs = 0;
        
        for (const pair of pairs) {
            try {
                const tokenFromId = tokenCache.get(pair.token0.symbol) || tokenCache.get(pair.token0.address);
                const tokenToId = tokenCache.get(pair.token1.symbol) || tokenCache.get(pair.token1.address);
                
                if (!tokenFromId || !tokenToId) continue;
                
                // Verificar si está deshabilitado por admin
                const existingPair = await pool.query(`
                    SELECT admin_disabled FROM trading_pairs 
                    WHERE token_from_id = $1 AND token_to_id = $2 AND gateway_id = $3
                `, [tokenFromId, tokenToId, gateway.id]);
                
                if (existingPair.rows.length > 0 && existingPair.rows[0].admin_disabled) {
                    skippedPairs++;
                    continue;
                }
                
                await pool.query(`
                    INSERT INTO trading_pairs (token_from_id, token_to_id, gateway_id, pair_id_external, reserve0, reserve1, is_active, last_sync_at)
                    VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
                    ON CONFLICT (token_from_id, token_to_id, gateway_id) 
                    DO UPDATE SET reserve0 = $5, reserve1 = $6, is_active = true, last_sync_at = NOW()
                    WHERE trading_pairs.admin_disabled = false
                `, [tokenFromId, tokenToId, gateway.id, pair.pairAddress || null, pair.reserve0, pair.reserve1]);
                
                updatedPairs++;
            } catch (err) {
                // Ignorar errores
            }
        }
        
        // Contar pares activos
        const activeCount = await pool.query(
            'SELECT COUNT(*) FROM trading_pairs WHERE is_active = true AND gateway_id = $1',
            [gateway.id]
        );
        
        console.log('[SYNC] ──────────────────────────────────────');
        console.log(`[SYNC] ✔ Sincronización completada`);
        console.log(`[SYNC]   Pares actualizados: ${updatedPairs}`);
        console.log(`[SYNC]   Pares saltados (admin_disabled): ${skippedPairs}`);
        console.log(`[SYNC]   Pares desactivados: ${deactivatedPairs}`);
        console.log(`[SYNC]   Total pares activos: ${activeCount.rows[0].count}`);
        console.log('[SYNC] ══════════════════════════════════════');
        
    } catch (error) {
        console.error('[SYNC] Error en sincronización:', error.message);
    }
}

// ============================================
// CRON - DCA EXECUTOR
// ============================================

async function executePendingDCAs() {
    console.log('[DCA] Buscando órdenes para ejecutar...');
    
    try {
        const orders = await pool.query(`
            SELECT o.*, u.wallet_address
            FROM dca_orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.is_active = true 
            AND o.next_execution <= NOW()
        `);
        
        console.log(`[DCA] Encontradas ${orders.rows.length} órdenes pendientes`);
        
        for (const order of orders.rows) {
            console.log(`[DCA] Procesando orden #${order.id}: ${order.token_from} → ${order.token_to}`);
            
            // Aquí iría la lógica real de ejecución del swap
            // Por ahora solo registramos una transacción pendiente
            
            await pool.query(`
                INSERT INTO transactions (dca_order_id, user_id, amount, token_from, token_to, status)
                VALUES ($1, $2, $3, $4, $5, 'pending')
            `, [order.id, order.user_id, order.amount, order.token_from, order.token_to]);
            
            // Actualizar próxima ejecución
            const nextExecution = calculateNextExecution(order.frequency);
            await pool.query(`
                UPDATE dca_orders 
                SET next_execution = $1, updated_at = NOW()
                WHERE id = $2
            `, [nextExecution, order.id]);
        }
        
    } catch (error) {
        console.error('[DCA] Error ejecutando órdenes:', error.message);
    }
}

// ============================================
// HELPERS
// ============================================

function calculateNextExecution(frequency) {
    const now = new Date();
    
    switch (frequency) {
        case 'daily':
            now.setDate(now.getDate() + 1);
            break;
        case 'weekly':
            now.setDate(now.getDate() + 7);
            break;
        case 'biweekly':
            now.setDate(now.getDate() + 14);
            break;
        case 'monthly':
            now.setMonth(now.getMonth() + 1);
            break;
        default:
            // Por defecto, 1 hora (para testing)
            now.setHours(now.getHours() + 1);
    }
    
    return now;
}

// ============================================
// INICIAR SERVIDOR
// ============================================

async function startServer() {
    // Test DB connection
    await testDatabaseConnection();
    
    // Iniciar cron jobs
    // DCA executor - cada hora
    cron.schedule('0 * * * *', executePendingDCAs);
    console.log('✔ Cron DCA iniciado (cada hora)');
    
    // Sync worker - cada 60 minutos
    cron.schedule('*/60 * * * *', syncWithSwopus);
    console.log('[SYNC] ✔ Sync Worker iniciado (cada 60 minutos)');
    
    // Iniciar servidor
    app.listen(PORT, () => {
        console.log('═══════════════════════════════════════');
        console.log(`✔ Servidor en puerto ${PORT}`);
        console.log(`✔ Entorno: ${process.env.NODE_ENV || 'development'}`);
        console.log('✔ Admin API: protegida');
        console.log('═══════════════════════════════════════');
    });
    
    // Ejecutar sync inicial
    console.log('[SYNC] Ejecutando sincronización inicial...');
    await syncWithSwopus();
}

startServer().catch(console.error);
