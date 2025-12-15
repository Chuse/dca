import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database.js';

// ==================== USER MODEL ====================
export class User extends Model {}

User.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  wallet_address: {
    type: DataTypes.STRING(62),
    allowNull: false,
    unique: true,
    validate: {
      notEmpty: true
    }
  }
}, {
  sequelize,
  modelName: 'User',
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// ==================== ORDER MODEL ====================
export class Order extends Model {}

Order.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  klv_per_buy: {
    type: DataTypes.DECIMAL(20, 6),
    allowNull: false,
    validate: {
      min: 0.000001
    }
  },
  frequency: {
    type: DataTypes.ENUM('Daily', 'Weekly', 'Biweekly', 'Monthly'),
    allowNull: false
  },
  total_executions: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1
    }
  },
  executions_done: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    validate: {
      min: 0
    }
  },
  status: {
    type: DataTypes.ENUM('Active', 'Paused', 'Completed', 'Cancelled'),
    defaultValue: 'Active'
  },
  next_execution: {
    type: DataTypes.DATE,
    allowNull: false
  },
  total_kfi_received: {
    type: DataTypes.DECIMAL(20, 6),
    defaultValue: 0
  },
  total_klv_spent: {
    type: DataTypes.DECIMAL(20, 6),
    defaultValue: 0
  },
  cancelled_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  cancellation_fee: {
    type: DataTypes.DECIMAL(20, 6),
    allowNull: true
  }
}, {
  sequelize,
  modelName: 'Order',
  tableName: 'orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// ==================== EXECUTION MODEL ====================
export class Execution extends Model {}

Execution.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'orders',
      key: 'id'
    }
  },
  klv_spent: {
    type: DataTypes.DECIMAL(20, 6),
    allowNull: false,
    validate: {
      min: 0.000001
    }
  },
  kfi_received: {
    type: DataTypes.DECIMAL(20, 6),
    allowNull: false,
    validate: {
      min: 0.000001
    }
  },
  price: {
    type: DataTypes.DECIMAL(20, 6),
    allowNull: false,
    validate: {
      min: 0.000001
    }
  },
  tx_hash: {
    type: DataTypes.STRING(128),
    allowNull: true
  },
  executed_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  sequelize,
  modelName: 'Execution',
  tableName: 'executions',
  timestamps: false
});

// ==================== RELATIONSHIPS ====================
User.hasMany(Order, { foreignKey: 'user_id', as: 'orders' });
Order.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Order.hasMany(Execution, { foreignKey: 'order_id', as: 'executions' });
Execution.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

// ==================== HELPER METHODS ====================

// Obtener segundos según frecuencia
export const getFrequencySeconds = (frequency) => {
  const map = {
    'Daily': 86400,        // 1 día
    'Weekly': 604800,      // 7 días
    'Biweekly': 1209600,   // 14 días
    'Monthly': 2592000     // 30 días
  };
  return map[frequency] || 604800;
};

// Calcular próxima ejecución
export const calculateNextExecution = (frequency, fromDate = new Date()) => {
  const seconds = getFrequencySeconds(frequency);
  const nextDate = new Date(fromDate);
  nextDate.setSeconds(nextDate.getSeconds() + seconds);
  return nextDate;
};

export { sequelize };
