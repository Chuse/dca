import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import sequelize, { testConnection } from './config/database.js';
import { User, Order, Execution, calculateNextExecution } from './models/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ==================== ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'DCA Backend is running' });
});

// ==================== AUTH ROUTES ====================

// Conectar wallet
app.post('/api/auth/connect', async (req, res) => {
  try {
    const { wallet_address } = req.body;

    if (!wallet_address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Buscar o crear usuario
    let [user, created] = await User.findOrCreate({
      where: { wallet_address },
      defaults: { wallet_address }
    });

    res.json({
      message: created ? 'User created' : 'User found',
      user: {
        id: user.id,
        wallet_address: user.wallet_address
      }
    });
  } catch (error) {
    console.error('Error connecting wallet:', error);
    res.status(500).json({ error: 'Failed to connect wallet' });
  }
});

// ==================== ORDER ROUTES ====================

// Crear orden
app.post('/api/orders', async (req, res) => {
  try {
    const { wallet_address, klv_per_buy, frequency, total_executions } = req.body;

    // Validar
    if (!wallet_address || !klv_per_buy || !frequency || !total_executions) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Buscar usuario
    const user = await User.findOne({ where: { wallet_address } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calcular next_execution
    const next_execution = calculateNextExecution(frequency);

    // Crear orden
    const order = await Order.create({
      user_id: user.id,
      klv_per_buy: parseFloat(klv_per_buy),
      frequency,
      total_executions: parseInt(total_executions),
      next_execution,
      status: 'Active',
      executions_done: 0,
      total_kfi_received: 0,
      total_klv_spent: 0
    });

    res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: order.id,
        klv_per_buy: order.klv_per_buy,
        frequency: order.frequency,
        total_executions: order.total_executions,
        status: order.status,
        next_execution: order.next_execution
      }
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Obtener órdenes del usuario
app.get('/api/orders', async (req, res) => {
  try {
    const { wallet_address } = req.query;

    if (!wallet_address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    const user = await User.findOne({ where: { wallet_address } });
    if (!user) {
      return res.json({ orders: [] });
    }

    const orders = await Order.findAll({
      where: { user_id: user.id },
      order: [['created_at', 'DESC']],
      include: [{
        model: Execution,
        as: 'executions',
        required: false
      }]
    });

    res.json({ orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Obtener orden específica
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [
        { model: User, as: 'user' },
        { model: Execution, as: 'executions' }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Pausar orden
app.put('/api/orders/:id/pause', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'Active') {
      return res.status(400).json({ error: 'Order is not active' });
    }

    order.status = 'Paused';
    await order.save();

    res.json({ message: 'Order paused successfully', order });
  } catch (error) {
    console.error('Error pausing order:', error);
    res.status(500).json({ error: 'Failed to pause order' });
  }
});

// Reanudar orden
app.put('/api/orders/:id/resume', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'Paused') {
      return res.status(400).json({ error: 'Order is not paused' });
    }

    order.status = 'Active';
    order.next_execution = calculateNextExecution(order.frequency);
    await order.save();

    res.json({ message: 'Order resumed successfully', order });
  } catch (error) {
    console.error('Error resuming order:', error);
    res.status(500).json({ error: 'Failed to resume order' });
  }
});

// Cancelar orden
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status === 'Completed' || order.status === 'Cancelled') {
      return res.status(400).json({ error: 'Cannot cancel this order' });
    }

    // Calcular devolución
    const executions_remaining = order.total_executions - order.executions_done;
    const klv_to_return = parseFloat(order.klv_per_buy) * executions_remaining;
    const fee_percent = parseFloat(process.env.CANCELLATION_FEE_PERCENT || 1);
    const fee = klv_to_return * (fee_percent / 100);
    const net_return = klv_to_return - fee;

    order.status = 'Cancelled';
    order.cancelled_at = new Date();
    order.cancellation_fee = fee;
    await order.save();

    res.json({
      message: 'Order cancelled successfully',
      order,
      refund: {
        klv_to_return,
        fee,
        net_return
      }
    });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ==================== EXECUTION ROUTES ====================

// Obtener ejecuciones de una orden
app.get('/api/orders/:id/executions', async (req, res) => {
  try {
    const executions = await Execution.findAll({
      where: { order_id: req.params.id },
      order: [['executed_at', 'DESC']]
    });

    res.json({ executions });
  } catch (error) {
    console.error('Error fetching executions:', error);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// ==================== PRICE ROUTES ====================

// Obtener precio de KFI
app.get('/api/prices/kfi', async (req, res) => {
  try {
    // TODO: Integrar con API real de Klever
    // Por ahora retorna precio simulado
    const price = 509.5 + (Math.random() - 0.5) * 10; // KLV por KFI

    res.json({
      price: price.toFixed(2),
      currency: 'KLV',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching price:', error);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

// ==================== BOT ROUTES (Admin) ====================

// Obtener órdenes pendientes
app.get('/api/bot/pending', async (req, res) => {
  try {
    const now = new Date();
    const pendingOrders = await Order.findAll({
      where: {
        status: 'Active',
        next_execution: { [sequelize.Sequelize.Op.lte]: now }
      },
      include: [{ model: User, as: 'user' }]
    });

    res.json({ orders: pendingOrders });
  } catch (error) {
    console.error('Error fetching pending orders:', error);
    res.status(500).json({ error: 'Failed to fetch pending orders' });
  }
});

// Ejecutar orden (simulado)
app.post('/api/bot/execute/:id', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'Active') {
      return res.status(400).json({ error: 'Order is not active' });
    }

    // Simular swap KLV → KFI
    const klv_spent = parseFloat(order.klv_per_buy);
    const price = 509.5; // KLV por KFI (simulado)
    const kfi_received = klv_spent / price;
    const tx_hash = 'sim_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Crear ejecución
    await Execution.create({
      order_id: order.id,
      klv_spent,
      kfi_received: kfi_received.toFixed(6),
      price: price.toFixed(2),
      tx_hash,
      executed_at: new Date()
    });

    // Actualizar orden
    order.executions_done += 1;
    order.total_klv_spent = parseFloat(order.total_klv_spent) + klv_spent;
    order.total_kfi_received = parseFloat(order.total_kfi_received) + kfi_received;
    order.next_execution = calculateNextExecution(order.frequency);

    if (order.executions_done >= order.total_executions) {
      order.status = 'Completed';
    }

    await order.save();

    res.json({
      message: 'Order executed successfully',
      execution: {
        klv_spent,
        kfi_received: kfi_received.toFixed(6),
        price,
        tx_hash
      },
      order
    });
  } catch (error) {
    console.error('Error executing order:', error);
    res.status(500).json({ error: 'Failed to execute order' });
  }
});

// ==================== START SERVER ====================

const startServer = async () => {
  // Test database connection
  const dbConnected = await testConnection();
  
  if (!dbConnected) {
    console.error('❌ Failed to start server: Database connection failed');
    process.exit(1);
  }

  // Sync models (only in development)
  if (process.env.NODE_ENV === 'development') {
    await sequelize.sync({ alter: false });
    console.log('✅ Database models synchronized');
  }

  // Start server
  app.listen(PORT, () => {
    console.log(`\n🚀 DCA Backend running on http://localhost:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`\n📋 API Endpoints:`);
    console.log(`   POST   /api/auth/connect`);
    console.log(`   POST   /api/orders`);
    console.log(`   GET    /api/orders?wallet_address=...`);
    console.log(`   GET    /api/orders/:id`);
    console.log(`   PUT    /api/orders/:id/pause`);
    console.log(`   PUT    /api/orders/:id/resume`);
    console.log(`   DELETE /api/orders/:id`);
    console.log(`   GET    /api/prices/kfi`);
    console.log(`   GET    /api/bot/pending`);
    console.log(`   POST   /api/bot/execute/:id\n`);
  });
};

startServer();
