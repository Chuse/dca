// Si existe DATABASE_URL, úsala (Railway)
const sequelize = process.env.DATABASE_URL 
  ? new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      },
      logging: false
    })
  : new Sequelize({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'dca_db',
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      dialect: 'postgres',
      logging: false
    });
