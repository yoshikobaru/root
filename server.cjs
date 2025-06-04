const https = require('https');  
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const crypto = require('crypto');
require('dotenv').config();
const { Sequelize, DataTypes, Op } = require('sequelize');
const url = require('url');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

// Функция для проверки статических запросов
const isStaticRequest = (pathname) => {
  const ext = path.extname(pathname).toLowerCase();
  return MIME_TYPES[ext] !== undefined;
};

// Функция для проверки хешированных ассетов
const isHashedAsset = (pathname) => {
  return pathname.startsWith('/assets/') && pathname.match(/[-_][a-zA-Z0-9]{8,}\./);
};

// Редис для уведомлений
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const Redis = require('ioredis');
const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    retryStrategy: function(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: null
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err);
});

redis.on('connect', () => {
    console.log('Successfully connected to Redis');
});

const isAdmin = (telegramId) => {
  return telegramId.toString() === ADMIN_ID;
};

// Создаем подключение к базе данных с логами только об ошибках, создавая пул в 50 подключений к бд
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD, 
  {
    host: process.env.DB_HOST,
    dialect: process.env.DB_DIALECT,
    logging: false, // Отключаем стандартные SQL логи
    logQueryParameters: false,
    benchmark: false,
    // Настраиваем кастомный logger
    logger: {
      error: (err) => {
        // Логируем ошибки БД
        if (err.original) { // Ошибки базы данных
          console.error('Database Error:', {
            message: err.original.message,
            code: err.original.code,
            timestamp: new Date().toISOString()
          });
        } else if (err.name === 'SequelizeValidationError') { // Ошибки валидации
          console.error('Validation Error:', {
            message: err.message,
            errors: err.errors.map(e => e.message),
            timestamp: new Date().toISOString()
          });
        } else { // Другие ошибки запросов
          console.error('Query Error:', {
            message: err.message,
            timestamp: new Date().toISOString()
          });
        }
      }
    },
    pool: {
      max: 50,
      min: 10,
      acquire: 30000,
      idle: 10000
    }
  }
);
sequelize.authenticate()
  .then(() => {
    console.log('Database connection has been established successfully.');
  })
  .catch(err => {
    console.error('Unable to connect to the database:', err);
  });

// Если нужно отслеживать отключение:
process.on('SIGINT', async () => {
  try {
    await sequelize.close();
    console.log('Database connection closed.');
    process.exit(0);
  } catch (err) {
    console.error('Error closing database connection:', err);
    process.exit(1);
  }
});

// Определяем модель User
const User = sequelize.define('User', {
  telegramId: {
    type: DataTypes.BIGINT, // Изменить тип с STRING на BIGINT
    allowNull: false,
    unique: true,
    index: true
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true
  },
  referralCode: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    index: true
  },
  referredBy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  referralRewardsCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false
  },
  rootBalance: {
    type: DataTypes.DECIMAL(10, 2), // для хранения значений с 2 знаками после запятой
    defaultValue: 0,
    index: true
  },
  lastTrial: {
    type: DataTypes.BIGINT,  // Используем BIGINT для timestamp
    allowNull: true,
    defaultValue: null
  },
  trialStatus: {
    type: DataTypes.STRING,  // 'started', 'ended', 'completed'
    allowNull: true,
    defaultValue: null
  },
  lastReward: {
    type: DataTypes.DATE,
    allowNull: true
  },
  claimedAchievements: {
    type: DataTypes.JSON,
    defaultValue: '[]'
  },
  maxEnergy: {
    type: DataTypes.INTEGER,
    defaultValue: 100
  },
  purchasedModes: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [], 
    allowNull: false
  },
  adWatchCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  lastAdUniqueId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  game2048Access: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  lastAdWatchTime: {
    type: DataTypes.DATE,
    allowNull: true
  }
});

const ActiveWallet = sequelize.define('ActiveWallet', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  address: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  balance: {
    type: DataTypes.DECIMAL(16, 8), 
    allowNull: false
  },
  mnemonic: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('active', 'discovered'),
    defaultValue: 'active'
  },
  discoveredBy: {
    type: DataTypes.BIGINT,
    allowNull: true
  },
  discoveryDate: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'ActiveWallets' // Явно указываем имя таблицы
});

const Settings = sequelize.define('Settings', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: false
  },
  marqueeActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'Settings'
});

// Синхронизируем модель с базой данных
sequelize.sync({ alter: true });
// Создаем экземпляр бота с вашим токеном
const bot = new Telegraf(process.env.ROOT_BOT_TOKEN);
// WebApp URL
const webAppUrl = 'https://walletfinder.ru';

// Флаг для отслеживания блокировки
let blockedUsers = new Set();

// Обработчик команды /start
bot.command('start', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || `user_${telegramId}`;
  const referralCode = ctx.message.text.split(' ')[1];

  try {
    let user = await User.findOne({ where: { telegramId } });

    if (!user) {
      const newReferralCode = crypto.randomBytes(4).toString('hex');
      
      try {
        user = await User.create({
          telegramId,
          username,
          referralCode: newReferralCode,
          referredBy: referralCode || null
        });
      } catch (createError) {
        if (createError.name === 'SequelizeUniqueConstraintError') {
          user = await User.findOne({ where: { telegramId } });
        } else {
          throw createError;
        }
      }

      if (referralCode) {
        const referrer = await User.findOne({ where: { referralCode } });
        if (referrer) {
          console.log(`User ${telegramId} was referred by ${referrer.telegramId}`);
        }
      }
    } else {      
      if (user.username !== username) {
        await user.update({ username });
      }
      
      if (!user.referredBy && referralCode) {
        const referrer = await User.findOne({ where: { referralCode } });
        if (referrer && referrer.telegramId !== telegramId) {
          await user.update({ referredBy: referralCode });
          console.log(`Existing user ${telegramId} was referred by ${referrer.telegramId}`);
        }
      }
    }

    // Отправляем приветственные смс
    await ctx.reply('I suppose right now you\'re feeling a bit like Alice falling down a rabbit hole? 🐰');
    await new Promise(resolve => setTimeout(resolve, 2000));
    await ctx.reply('Take the red pill, stay in Wonderland, and I\'ll show you how deep the rabbit hole goes... 💊');
    await new Promise(resolve => setTimeout(resolve, 2000));
    await ctx.reply('Are you ready to join right now? 🚀', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Join RootBTC 🔐', url: 'https://t.me/RootBTC_bot/start' }
        ]]
      }
    });

  } catch (error) {
    if (error.response && error.response.error_code === 403) {
      if (!blockedUsers.has(telegramId)) {
        console.error(`User ${telegramId} has blocked the bot. Message not sent.`);
        blockedUsers.add(telegramId); // Добавляем в множество заблокированных
      }
    } else {
      console.error('Error in start command:', error);
    }
  }
});

// Добавляем обработчик команды /paysupport
bot.command('paysupport', async (ctx) => {
  try {
    await ctx.reply('If you have any issues or questions, please contact our moderator:\n@manager_root_1\n\nWith ❤️,\nRoot Founder.');
  } catch (error) {
    console.error('Error in paysupport command:', error);
  }
});

// Запускаем бота
bot.launch();
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (error) {
    console.error('Error in pre_checkout_query:', error);
  }
});

// Обработка successful_payment
bot.on('successful_payment', async (ctx) => {
  try {
    console.log('=== PAYMENT HANDLER TRIGGERED ===');
    const payment = ctx.message.successful_payment;
    console.log('Payment data:', payment);

    const payload = payment.invoice_payload;
    console.log('Full payload:', payload);

    // Правильно разбираем payload для разных типов покупок
    let type, telegramId, itemId, amount;
    if (payload.includes('capacity_')) {
      [type, telegramId, _, amount] = payload.split('_');
      amount = parseInt(amount); // преобразуем в число
      console.log('Parsed capacity payment:', { type, telegramId, amount });
    } else if (payload.includes('support_')) {
      // Для поддержки: support_telegramId_support_stars_amount_timestamp
      const parts = payload.split('_');
      type = parts[0]; // 'support'
      telegramId = parts[1];
      itemId = parts.slice(2).join('_'); // 'support_stars_amount_timestamp'
      console.log('Parsed support payment:', { type, telegramId, itemId });
    } else {
      [type, telegramId, itemId] = payload.split('_');
      console.log('Parsed regular payment:', { type, telegramId, itemId });
    }

    const user = await User.findOne({ where: { telegramId } });
    if (!user) {
      console.error('User not found:', telegramId);
      return;
    }

    if (type === 'energy') {
      if (itemId === 'energy_full') {
        await ctx.reply('⚡️ Energy restored to 100%!');
      } else if (amount) { // для capacity
        console.log('Current maxEnergy:', user.maxEnergy);
        console.log('Adding amount:', amount);
        
        const currentMaxEnergy = user.maxEnergy || 100;
        const newMaxEnergy = currentMaxEnergy + amount;
        
        console.log('Setting new maxEnergy:', newMaxEnergy);
        await user.update({ maxEnergy: newMaxEnergy });
        
        console.log('MaxEnergy updated to:', newMaxEnergy);
        await ctx.reply(`🔋 Energy capacity increased by ${amount}%! New capacity: ${newMaxEnergy}%`);
      }
    } else if (type === 'mode') {
      const updatedModes = [...new Set([...user.purchasedModes, itemId])];
      await user.update({ purchasedModes: updatedModes });
      await ctx.reply(`✨ Mode ${itemId} unlocked successfully!`);
    } else if (type === 'support') {
      // Обработка покупок поддержки
      console.log('Support purchase completed:', { telegramId, itemId });
      await ctx.reply(`🚀 Thank you for supporting RootBTC! Your contribution helps us grow! 💎`);
    }
  } catch (error) {
    console.error('Error in successful_payment:', error);
    console.error('Full error:', error.stack);
  }
});

function validateInitData(initData) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  
  // Сортируем оставшиеся параметры
  const params = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
    
  // Создаем HMAC
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.ROOT_BOT_TOKEN)
    .digest();
    
  const generatedHash = crypto.createHmac('sha256', secret)
    .update(params)
    .digest('hex');
    
  return generatedHash === hash;
}

async function authMiddleware(req, res) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData || !validateInitData(initData)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  return null;
}

const getRequestBody = (req) => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
};

const routes = {
  GET: {
 '/get-user': async (req, res, query) => {
  // Добавляем проверку авторизации
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  const telegramId = query.telegramId;
  
  if (!telegramId) {
    return { 
      status: 400, 
      body: { error: 'Telegram ID is required' } 
    };
  }

  try {
    // Проверяем соответствие ID пользователя из initData с запрашиваемым ID
    const initData = new URLSearchParams(req.headers['x-telegram-init-data']);
    const userData = JSON.parse(initData.get('user'));
    if (userData.id.toString() !== telegramId) {
      return { 
        status: 403, 
        body: { error: 'Unauthorized: User ID mismatch' } 
      };
    }

    let user = await User.findOne({ where: { telegramId } });
    
    // Если пользователь не найден - создаем его (как в обработчике /start)
    if (!user) {
      const username = userData.username || userData.first_name || `user_${telegramId}`;
      const newReferralCode = crypto.randomBytes(4).toString('hex');
      
      try {
        user = await User.create({
          telegramId,
          username,
          referralCode: newReferralCode,
          referredBy: query.ref || null  // Опционально: поддержка реферальных кодов
        });
      } catch (createError) {
        if (createError.name === 'SequelizeUniqueConstraintError') {
          user = await User.findOne({ where: { telegramId } });
        } else {
          console.error('Error creating user:', createError);
          return { 
            status: 500, 
            body: { error: 'Failed to create user' } 
          };
        }
      }
    } else {
      // Проверяем наличие реферального кода
      if (!user.referralCode) {
        const newReferralCode = crypto.randomBytes(4).toString('hex');
        await user.update({ referralCode: newReferralCode });
        user = await User.findOne({ where: { telegramId } });
      }
    }

    let settings = await Settings.findByPk(1);
    if (!settings) {
      settings = await Settings.create({ id: 1, marqueeActive: false });
    }

    return { 
      status: 200, 
      body: {
        success: true,
        user: {
          id: user.id,
          telegramId: user.telegramId,
          username: user.username,
          referralCode: user.referralCode,
          rootBalance: user.rootBalance,
          referredBy: user.referredBy,
          marqueeActive: settings.marqueeActive
        }
      }
    };
  } catch (error) {
    console.error('Error getting user:', error);
    return { 
      status: 500, 
      body: { error: 'Failed to get user' } 
    };
  }
},
'/aw': async (req, res, query) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  try {
    // Проверяем наличие активных кошельков (без отправки данных)
    const hasActiveWallets = await ActiveWallet.count({
      where: { status: 'active' }
    }) > 0;

    // Возвращаем только статус наличия активных кошельков
    return { 
      status: 200,
      body: { 
        hasActiveWallets,
        placeholder: {
          address: 'bc1placeholder',
          balance: '0.00000000'
        }
      }
    };
  } catch (error) {
    console.error('Error checking active wallets:', error);
    return { 
      status: 500, 
      body: { error: 'Internal server error' }
    };
  }
},
'/get-root-balance': async (req, res, query) => {
      // Добавляем проверку авторизации
      const authError = await authMiddleware(req, res);
      if (authError) return authError;

      const telegramId = query.telegramId;
      
      if (!telegramId) {
        return { 
          status: 400, 
          body: { error: 'Missing telegramId parameter' } 
        };
      }
  
      try {
        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
          return { 
            status: 404, 
            body: { 
              success: false,
              error: 'User not found' 
            } 
          };
        }
  
        return { 
          status: 200, 
          body: { 
            success: true,
            rootBalance: user.rootBalance,
            user: {
              telegramId: user.telegramId,
              username: user.username,
              referralCode: user.referralCode
            }
          } 
        };
      } catch (error) {
        console.error('Error getting root balance:', error);
        return { 
          status: 500, 
          body: { 
            success: false,
            error: 'Internal server error' 
          } 
        };
      }
    },
    '/get-referral-link': async (req, res, query) => {
      console.log('Получен запрос на /get-referral-link');
      const telegramId = query.telegramId;
      
      if (!telegramId) {
        console.log('Отсутствует telegramId');
        return { status: 400, body: { error: 'Missing telegramId parameter' } };
      }

      try {
        console.log('Поиск пользователя с telegramId:', telegramId);
        const user = await User.findOne({ where: { telegramId } });
        if (user) {
          const inviteLink = `https://t.me/RootBTC_bot?start=${user.referralCode}`;
          console.log('Сгенерирована ссылка:', inviteLink);
          return { status: 200, body: { inviteLink } };
        } else {
          console.log('Пользователь не найден');
          return { status: 404, body: { error: 'User not found' } };
        }
      } catch (error) {
        console.error('Ошибка при обработке запроса:', error);
        return { status: 500, body: { error: 'Internal server error' } };
      }
    },
'/get-settings': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError; // Возвращаем объект ошибки

  try {
    const settings = await Settings.findOne();
    if (!settings) {
      return { 
        status: 404, 
        body: { error: 'Settings not found' } 
      };
    }
    
    return { 
      status: 200, 
      body: { marqueeActive: settings.marqueeActive } 
    };
    
  } catch (error) {
    console.error('Error fetching settings:', error);
    return { 
      status: 500, 
      body: { error: 'Failed to fetch settings' } 
    };
  }
},
'/get-referral-count': async (req, res, query) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  const telegramId = query.telegramId;
  
  if (!telegramId) {
    return { 
      status: 400, 
      body: { error: 'Telegram ID is required' } 
    };
  }

  try {
    const user = await User.findOne({ where: { telegramId } });
    if (!user) {
      return { 
        status: 404, 
        body: { error: 'User not found' } 
      };
    }

    // Получаем количество рефералов
    const referralCount = await User.count({
      where: { referredBy: user.referralCode }
    });

    // Используем текущий referralRewardsCount пользователя
    const currentRewardsCount = user.referralRewardsCount || 0;
    // Теперь награда выдается за каждого реферала
    const possibleRewardsCount = referralCount;
    
    // Проверяем, есть ли новые доступные награды
    const hasNewRewards = possibleRewardsCount > currentRewardsCount;

    // Если есть новые награды, обновляем счетчик
    if (hasNewRewards) {
      await user.update({
        referralRewardsCount: possibleRewardsCount
      });
    }

    return { 
      status: 200, 
      body: { 
        success: true,
        count: referralCount,
        rewardsEarned: possibleRewardsCount,
        nextRewardAt: possibleRewardsCount + 1,
        hasNewRewards
      } 
    };
  } catch (error) {
    console.error('Error getting referral count:', error);
    return { 
      status: 500, 
      body: { error: 'Failed to get referral count' } 
    };
  }
},
'/create-mode-invoice': async (req, res, query) => {
    // Добавляем проверку авторизации
    const authError = await authMiddleware(req, res);
    if (authError) return authError;

    const { telegramId, type, itemId } = query;
    
    if (!telegramId || !type) {
        return { status: 400, body: { error: 'Missing required parameters' } };
    }

    const prices = {
        mode: {
            'basic': 149,
            'advanced': 349,
            'expert': 499
        },
        energy: {
            'energy_full': 49,
            'capacity_50': 149,
            'capacity_100': 249,
            'capacity_250': 499
        },
        support: {
            // Динамические цены для поддержки - будут извлечены из itemId
        }
    };

    try {
        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
            return { status: 404, body: { error: 'User not found' } };
        }

        // Проверка для режимов
        if (type === 'mode' && user.purchasedModes.includes(itemId)) {
            return { status: 400, body: { error: 'Mode already purchased' } };
        }

        let title, description, price;
        if (type === 'mode') {
            title = 'ROOTBTC Mode Upgrade';
            description = `Upgrade to ${itemId.charAt(0).toUpperCase() + itemId.slice(1)} mode`;
            price = prices[type][itemId];
        } else if (type === 'energy') {
            if (itemId === 'energy_full') {
                title = 'Energy Refill';
                description = 'Instant energy refill to 100%';
            } else {
                const amount = itemId.split('_')[1];
                title = 'Energy Capacity Upgrade';
                description = `Increase maximum energy by ${amount}%`;
            }
            price = prices[type][itemId];
        } else if (type === 'support') {
            // Для поддержки извлекаем цену из itemId
            const match = itemId.match(/support_stars_(\d+)_/);
            if (!match) {
                return { status: 400, body: { error: 'Invalid support itemId format' } };
            }
            price = parseInt(match[1]);
            title = 'ROOTBTC Support';
            description = `Support RootBTC project with ${price} stars`;
        }

        if (!price) {
            return { status: 400, body: { error: 'Price not found for this item' } };
        }

        const invoice = await bot.telegram.createInvoiceLink({
            title,
            description,
            payload: `${type}_${telegramId}_${itemId}`,
            provider_token: "",
            currency: 'XTR',
            prices: [{
                label: '⭐️ Purchase',
                amount: price
            }]
        });

        return { status: 200, body: { slug: invoice } };
    } catch (error) {
        console.error('Error creating invoice:', error);
        return { status: 500, body: { error: 'Failed to create invoice' } };
    }
},
'/get-user-modes': async (req, res, query) => {
    // Только проверка авторизации
    const authError = await authMiddleware(req, res);
    if (authError) return authError;

    const { telegramId } = query;
    
    if (!telegramId) {
        return { status: 400, body: { error: 'Missing telegramId parameter' } };
    }

    try {
        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
            return { status: 404, body: { error: 'User not found' } };
        }

        return { 
            status: 200, 
            body: { 
                purchasedModes: user.purchasedModes,
                maxEnergy: user.maxEnergy || 100
            }
        };
    } catch (error) {
        console.error('Error getting user data:', error);
        return { status: 500, body: { error: 'Failed to get user data' } };
    }
},
'/get-leaderboard': async (req, res, query) => {  // добавляем query параметр
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  try {
    const currentUserId = query.telegramId;  // получаем из query вместо req.telegramId
    let userPosition = null;

    // Если есть текущий пользователь, сначала определяем его позицию
    if (currentUserId) {
      const currentUser = await User.findOne({
        where: { telegramId: currentUserId },
        attributes: ['telegramId', 'username', 'rootBalance']
      });
      
      if (currentUser) {
        // Эффективный запрос - просто считаем записи с более высоким балансом
        userPosition = await User.count({
          where: {
            rootBalance: {
              [Op.gt]: currentUser.rootBalance
            }
          }
        });

        // Добавляем данные текущего пользователя
        currentUserData = {
          id: currentUser.telegramId,
          username: currentUser.username || 'Anonymous',
          avatar_style: parseInt(currentUser.telegramId) % 4,
          root_balance: Number(parseFloat(currentUser.rootBalance).toFixed(2)),
          rank: userPosition + 1
        };
      }
    }

    // Получаем топ-50
    const leaders = await User.findAll({
      where: {
        rootBalance: {
          [Op.gt]: 0
        }
      },
      attributes: ['telegramId', 'username', 'rootBalance'],
      order: [['rootBalance', 'DESC']], 
      limit: 50
    });

    const formattedLeaders = leaders.map((user, index) => ({
      id: user.telegramId,
      username: user.username || 'Anonymous',
      avatar_style: parseInt(user.telegramId) % 4,
      root_balance: Number(parseFloat(user.rootBalance).toFixed(2)),
      rank: index + 1,
      isCurrentUser: user.telegramId === currentUserId
    }));

    return {
      status: 200,
      body: {
        leaders: formattedLeaders,
        currentUser: currentUserData,
        currentUserRank: userPosition !== null ? userPosition + 1 : null
      }
    };

  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return {
      status: 500,
      body: { error: 'Failed to fetch leaderboard' }
    };
  }
},
'/response': async (req, res, query) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  try {
    const { userId } = query;
    const userIdNum = parseInt(userId);
    const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID);
    const isAdmin = userIdNum === adminId;

    // Получаем данные пользователя из initData в headers
    const initData = new URLSearchParams(req.headers['x-telegram-init-data']);
    const userData = JSON.parse(initData.get('user'));
    
    console.log(`👤 User: ${userData.username || userData.first_name || 'Unknown'} (${userData.id}) | Admin: ${isAdmin ? '✅' : '❌'}`);

    return {
      status: 200,
      body: { response: isAdmin }
    };
  } catch (error) {
    console.error('responseadm check error:', error);
    return {
      status: 500,
      body: { error: 'Internal Server Error' }
    };
  }
},
'/admin/get-stats': async (req, res, query) => {
    // Добавляем проверку авторизации
    const authError = await authMiddleware(req, res);
    if (authError) return authError;

    const { adminId, type } = query;
    
    if (!isAdmin(adminId)) {
      return {
        status: 403,
        body: { error: 'Unauthorized: Admin access required' }
      };
    }

    try {
      const stats = {
        totalWallets: await ActiveWallet.count(),
        activeWallets: await ActiveWallet.count({ where: { status: 'active' } }),
        discoveredWallets: await ActiveWallet.count({ where: { status: 'discovered' } }),
        totalUsers: await User.count(),
        totalBalance: await ActiveWallet.sum('balance')
      };

      // Если запрошен конкретный тип, возвращаем детальные данные
      if (type) {
        let wallets;
        switch(type) {
          case 'total':
            wallets = await ActiveWallet.findAll({
              attributes: ['address', 'balance', 'status', 'createdAt']
            });
            break;
          case 'active':
            wallets = await ActiveWallet.findAll({
              where: { status: 'active' },
              attributes: ['address', 'balance', 'createdAt']
            });
            break;
          case 'discovered':
            wallets = await ActiveWallet.findAll({
              where: { status: 'discovered' },
              attributes: ['address', 'balance', 'createdAt']
            });
            break;
        }
        return {
          status: 200,
          body: { stats, wallets }
        };
      }

      return {
        status: 200,
        body: { stats }
      };
    } catch (error) {
      console.error('Failed to get stats:', error);
      return {
        status: 500,
        body: { error: 'Failed to get stats' }
      };
    }
  },
  '/get-game-access': async (req, res, query) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;

    const telegramId = query.telegramId;
    if (!telegramId) {
      return { status: 400, body: { error: 'Missing telegramId parameter' } };
    }

    try {
      const user = await User.findOne({ where: { telegramId } });
      if (!user) {
        return { status: 404, body: { error: 'User not found' } };
      }
      return { status: 200, body: { success: true, access: !!user.game2048Access } };
    } catch (error) {
      console.error('Error getting game access:', error);
      return { status: 500, body: { error: 'Internal server error' } };
    }
  },
  '/check-reward-time': async (req, res, query) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  const telegramId = query.telegramId;
  
  if (!telegramId) {
    return { 
      status: 400, 
      body: { error: 'Missing telegramId parameter' } 
    };
  }

  try {
    const user = await User.findOne({ where: { telegramId } });
    if (!user) {
      return { 
        status: 404, 
        body: { error: 'User not found' } 
      };
    }

    // Получаем серверное время
    const serverTime = new Date();
    const today = serverTime.toISOString().split('T')[0];

    // Проверяем последнюю награду
    const lastReward = user.lastReward ? new Date(user.lastReward) : null;
    const hasRewardedToday = lastReward && 
      lastReward.toISOString().split('T')[0] === today;

    return { 
      status: 200, 
      body: { 
        success: true,
        hasRewardedToday,
        serverTime: serverTime.toISOString()
      } 
    };
  } catch (error) {
    console.error('Error checking reward time:', error);
    return { 
      status: 500, 
      body: { error: 'Failed to check reward time' } 
    };
  }
},
'/get-trial-status': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  // Правильно получаем параметры из URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const telegramId = url.searchParams.get('telegramId');
  
  if (!telegramId) {
    return { 
      status: 400, 
      body: { error: 'Missing telegramId parameter' } 
    };
  }

  try {
    const user = await User.findOne({ where: { telegramId } });
    if (!user) {
      return { 
        status: 404, 
        body: { error: 'User not found' } 
      };
    }

    return { 
      status: 200, 
      body: { 
        success: true,
        lastTrial: user.lastTrial,
        status: user.trialStatus, // Изменили trialStatus на status для консистентности
        purchasedModes: user.purchasedModes
      } 
    };
  } catch (error) {
    console.error('Error getting trial status:', error);
    return { 
      status: 500, 
      body: { error: 'Failed to get trial status' } 
    };
  }
},
'/reward': async (req, res, query) => {
    const telegramId = query.userid;
    
    if (!telegramId) {
        return { status: 400, body: { error: 'Missing userid parameter' } };
    }

    try {
        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
            return { status: 404, body: { error: 'User not found' } };
        }

        // Обновляем только счетчик просмотров рекламы
        await user.update({
            adWatchCount: (user.adWatchCount || 0) + 1
        });

        return { status: 200, body: { 
            success: true, 
            message: 'Ad view recorded',
            adWatchCount: user.adWatchCount + 1
        }};
    } catch (error) {
        console.error('Error in reward endpoint:', error);
        return { status: 500, body: { error: 'Internal server error' } };
    }
    }
  },
    POST: {
      '/update-root-balance': async (req, res) => {
        const authError = await authMiddleware(req, res);
        if (authError) return authError;
      
        let body = '';
        req.on('data', chunk => { body += chunk; });
        
        return new Promise((resolve) => {
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const { telegramId, rootBalance } = data;
      
              if (!telegramId || rootBalance === undefined) {
                resolve({ status: 400, body: { error: 'Missing required parameters' } });
                return;
              }
      
              const user = await User.findOne({ where: { telegramId } });
              if (!user) {
                resolve({ status: 404, body: { error: 'User not found' } });
                return;
              }
      
              await user.update({ rootBalance });
      
              resolve({
                status: 200,
                body: { 
                  success: true,
                  rootBalance: user.rootBalance
                }
              });
            } catch (error) {
              console.error('Error updating root balance:', error);
              resolve({ 
                status: 500, 
                body: { error: 'Internal server error' } 
              });
            }
          });
        });
      },
      '/dw': async (req, res) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;
  
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    return new Promise((resolve) => {
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { displayAddress, telegramId } = data;
          console.log('Received discovery request:', { displayAddress, telegramId });

          if (!telegramId) {
            resolve({
              status: 400,
              body: { 
                success: false, 
                error: 'Missing telegramId' 
              }
            });
            return;
          }

          // Получаем случайный активный кошелек
          const wallet = await ActiveWallet.findOne({
            where: { status: 'active' },
            order: sequelize.random()
          });
          if (!wallet) {
            resolve({
              status: 404,
              body: { 
                success: false, 
                error: 'No active wallets available' 
              }
            });
            return;
          }

          // Обновляем статус кошелька
          await wallet.update({
            status: 'discovered',
            discoveredBy: telegramId,
            discoveryDate: new Date()
          });
          console.log('Updated wallet status to discovered');

          resolve({
            status: 200,
            body: {
              success: true,
              wallet: {
                address: wallet.address,
                balance: wallet.balance,
                mnemonic: wallet.mnemonic
              },
              displayAddress
            }
          });

        } catch (error) {
          console.error('Error discovering wallet:', error);
          resolve({
            status: 500,
            body: { 
              success: false, 
              error: 'Failed to process discovery' 
            }
          });
        }
      });
    });
  },
'/admin/delete-wallet': async (req, res) => {
  // Добавляем проверку авторизации
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  try {
    const body = await getRequestBody(req);
    const { adminId, address } = body;
    
    if (!isAdmin(adminId)) {
      return {
        status: 403,
        body: { error: 'Unauthorized: Admin access required' }
      };
    }

    const result = await ActiveWallet.destroy({
      where: { address }
    });

    if (result === 0) {
      return {
        status: 404,
        body: { error: 'Wallet not found' }
      };
    }

    return {
      status: 200,
      body: { success: true, message: 'Wallet deleted successfully' }
    };
  } catch (error) {
    console.error('Failed to delete wallet:', error);
    return {
      status: 500,
      body: { error: 'Failed to delete wallet' }
    };
  }
},
'/update-user-modes': async (req, res) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;
  
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    return new Promise((resolve) => {
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { telegramId, modeName, maxEnergy } = data;
          console.log('Received mode update request:', { telegramId, modeName, maxEnergy });

          if (!telegramId) {
            resolve({
              status: 400,
              body: {
                success: false,
                error: 'Missing telegramId parameter'
              }
            });
            return;
          }

          // Если передан только maxEnergy без modeName, обновляем только энергию
          if (maxEnergy && !modeName) {
            const user = await User.findOne({ where: { telegramId } });
            if (!user) {
              resolve({
                status: 404,
                body: {
                  success: false,
                  error: 'User not found'
                }
              });
              return;
            }

            await user.update({ maxEnergy });
            console.log('Updated maxEnergy only:', { telegramId, maxEnergy });

            resolve({
              status: 200,
              body: {
                success: true,
                maxEnergy: maxEnergy
              }
            });
            return;
          }

          if (!modeName) {
            resolve({
              status: 400,
              body: {
                success: false,
                error: 'Missing modeName parameter'
              }
            });
            return;
          }

          const user = await User.findOne({ where: { telegramId } });
          if (!user) {
            resolve({
              status: 404,
              body: { 
                success: false, 
                error: 'User not found' 
              }
            });
            return;
          }

          // Специальная логика для lightspeed mode - он приоритетный
          if (modeName === 'lightspeed') {
            // Проверяем, есть ли уже lightspeed
            if (user.purchasedModes.includes('lightspeed')) {
              resolve({
                status: 200,
                body: {
                  success: true,
                  purchasedModes: user.purchasedModes,
                  message: 'Lightspeed mode already activated'
                }
              });
              return;
            }

            // Добавляем lightspeed в начало массива для приоритета
            const updatedModes = ['lightspeed', ...user.purchasedModes.filter(mode => mode !== 'lightspeed')];
            await user.update({ purchasedModes: updatedModes });
            console.log('Lightspeed mode activated:', { telegramId, updatedModes });

            resolve({
              status: 200,
              body: {
                success: true,
                purchasedModes: updatedModes,
                message: 'Lightspeed mode activated!'
              }
            });
            return;
          }

          // Для других режимов - обычная логика
          if (user.purchasedModes.includes(modeName)) {
            resolve({
              status: 200,
              body: {
                success: true,
                purchasedModes: user.purchasedModes,
                message: 'Mode already purchased'
              }
            });
            return;
          }

          const updatedModes = [...new Set([...user.purchasedModes, modeName])];
          await user.update({ purchasedModes: updatedModes });
          console.log('Updated user modes:', { telegramId, updatedModes });

          resolve({
            status: 200,
            body: {
              success: true,
              purchasedModes: updatedModes
            }
          });

        } catch (error) {
          console.error('Error updating user modes:', error);
          resolve({
            status: 500,
            body: { 
              success: false, 
              error: 'Failed to update user modes' 
            }
          });
        }
      });
    });
  },
'/admin/update-marquee': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  try {
    const body = await getRequestBody(req);
    const { marquee } = body;
    
    if (typeof marquee !== 'boolean') {
      return { status: 400, body: { error: 'Invalid marquee parameter' } };
    }

    await Settings.upsert(
      { 
        id: 1, // Явно указываем ID
        marqueeActive: marquee 
      },
      { 
        where: { id: 1 } // Условие поиска
      }
    );

    return { status: 200, body: { success: true } };
    
  } catch (error) {
    console.error('Error updating marquee:', error);
    return { status: 500, body: { error: 'Failed to update marquee' } };
  }
},
'/admin/get-wallets': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  try {
    // Получаем тело запроса
    const body = await getRequestBody(req);
    const { adminId } = body;
    
    if (!isAdmin(adminId)) {
      return {
        status: 403,
        body: { error: 'Unauthorized: Admin access required' }
      };
    }

    // Получаем все кошельки для админа
    const wallets = await ActiveWallet.findAll({
      attributes: ['id', 'address', 'balance', 'status', 'discoveredBy', 'discoveryDate', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });

    return {
      status: 200,
      body: { 
        success: true,
        wallets 
      }
    };
  } catch (error) {
    console.error('Failed to get wallets:', error);
    return {
      status: 500,
      body: { error: 'Failed to get wallets' }
    };
  }
},
'/purchase-with-ton': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  let body = '';
  req.on('data', chunk => { body += chunk; });
  
  return new Promise((resolve) => {
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log('Received TON purchase data:', data);

        const { telegramId, type, itemId, transactionBoc, userAddress } = data;

        if (!telegramId || !type || !itemId || !transactionBoc) {
          resolve({ status: 400, body: { error: 'Missing required parameters' } });
          return;
        }

        // Проверяем валидность itemId в зависимости от типа
        const isValidItemId = type === 'energy' ?
          (itemId === 'energy_full' || itemId.match(/^capacity_\d+$/)) :
          type === 'mode' ?
          ['basic', 'advanced', 'expert'].includes(itemId) :
          type === 'support' ?
          (itemId.startsWith('support_stars_') || itemId.startsWith('support_ton_')) :
          false;

        if (!isValidItemId) {
          console.error(`Invalid ${type} format:`, itemId);
          resolve({
            status: 400,
            body: { error: `Invalid ${type} format: ${itemId}` }
          });
          return;
        }

        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
          resolve({ status: 404, body: { error: 'User not found' } });
          return;
        }

        console.log('Processing purchase for user:', {
          telegramId,
          type,
          itemId,
          currentModes: user.purchasedModes,
          currentEnergy: user.energy,
          currentMaxEnergy: user.maxEnergy,
          userAddress
        });

        // Проверяем тип покупки
        if (type === 'mode') {
          // Проверка что режим еще не куплен
          const currentModes = Array.isArray(user.purchasedModes) ? user.purchasedModes : [];
          if (currentModes.includes(itemId)) {
            resolve({ status: 400, body: { error: 'Mode already purchased' } });
            return;
          }

          const purchasedModes = [...currentModes, itemId];
          await user.update({ purchasedModes });
          
          console.log('Mode purchase successful:', {
            telegramId,
            itemId,
            purchasedModes,
            userAddress
          });

          resolve({
            status: 200,
            body: { 
              success: true,
              message: `${itemId} mode purchased successfully`,
              user: {
                purchasedModes,
                telegramId: user.telegramId,
                userAddress
              }
            }
          });
          return;
        }
        
        if (type === 'energy') {
          const currentMaxEnergy = user.maxEnergy || 100;

          if (itemId === 'energy_full') {
            await user.update({ 
              energy: currentMaxEnergy
            });
            
            console.log('Energy refill successful:', {
              telegramId,
              energy: currentMaxEnergy,
              maxEnergy: currentMaxEnergy,
              userAddress
            });

            resolve({
              status: 200,
              body: { 
                success: true,
                message: 'Energy refilled to maximum',
                user: {
                  energy: currentMaxEnergy,
                  maxEnergy: currentMaxEnergy,
                  telegramId: user.telegramId,
                  userAddress
                }
              }
            });
          } else {
            const match = itemId.match(/capacity_(\d+)/);
            if (!match) {
              resolve({ status: 400, body: { error: 'Invalid capacity format' } });
              return;
            }

            const capacityIncrease = parseInt(match[1], 10);
            if (isNaN(capacityIncrease)) {
              resolve({ status: 400, body: { error: 'Invalid capacity value' } });
              return;
            }

            const newMaxEnergy = currentMaxEnergy + capacityIncrease;
            
            await user.update({ 
              maxEnergy: newMaxEnergy,
              energy: newMaxEnergy
            });

            console.log('Energy capacity upgrade successful:', {
              telegramId,
              oldMaxEnergy: currentMaxEnergy,
              newMaxEnergy,
              increase: capacityIncrease,
              userAddress
            });

            resolve({
              status: 200,
              body: { 
                success: true,
                message: `Energy capacity increased by ${capacityIncrease}`,
                user: {
                  energy: newMaxEnergy,
                  maxEnergy: newMaxEnergy,
                  telegramId: user.telegramId,
                  userAddress
                }
              }
            });
          }
          return;
        }

        if (type === 'support') {
          // Обработка покупок поддержки
          console.log('Processing support purchase:', {
            telegramId,
            itemId,
            userAddress
          });

          resolve({
            status: 200,
            body: {
              success: true,
              message: 'Support purchase processed successfully',
              user: {
                telegramId: user.telegramId,
                userAddress
              }
            }
          });
          return;
        }

        resolve({
          status: 400,
          body: { error: 'Invalid purchase type' }
        });

      } catch (error) {
        console.error('Error processing TON purchase:', error);
        resolve({ 
          status: 500, 
          body: { 
            error: 'Failed to process purchase',
            details: error.message 
          }
        });
      }
    });
  });
},
'/update-energy': async (req, res) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;
    
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    return new Promise((resolve) => {
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { telegramId, type, value } = data;
          
          if (!telegramId || !type) {
            resolve({ status: 400, body: { error: 'Missing required parameters' } });
            return;
          }

          const user = await User.findOne({ where: { telegramId } });
          if (!user) {
            resolve({ status: 404, body: { error: 'User not found' } });
            return;
          }

          const currentMaxEnergy = user.maxEnergy || 100;

          console.log('Processing energy update:', {
            telegramId,
            type,
            value,
            currentEnergy: user.energy,
            currentMaxEnergy
          });

          if (type === 'refill') {
            // Восстанавливаем энергию до максимума
            await user.update({ energy: currentMaxEnergy });
            
            console.log('Energy refill successful:', {
              telegramId,
              newEnergy: currentMaxEnergy
            });

            resolve({
              status: 200,
              body: { 
                success: true,
                energy: currentMaxEnergy,
                maxEnergy: currentMaxEnergy
              }
            });
            return;
          } 
          
          if (type === 'capacity') {
            if (!value) {
              resolve({ status: 400, body: { error: 'Missing value for capacity update' } });
              return;
            }

            const newMaxEnergy = currentMaxEnergy + parseInt(value);
            await user.update({ 
              maxEnergy: newMaxEnergy,
              energy: newMaxEnergy
            });

            console.log('Energy capacity upgrade successful:', {
              telegramId,
              oldMaxEnergy: currentMaxEnergy,
              newMaxEnergy,
              increase: value
            });

            resolve({
              status: 200,
              body: { 
                success: true,
                energy: newMaxEnergy,
                maxEnergy: newMaxEnergy
              }
            });
            return;
          }

          resolve({
            status: 400,
            body: { error: 'Invalid energy update type' }
          });

        } catch (error) {
          console.error('Error updating energy:', error);
          resolve({ 
            status: 500, 
            body: { 
              error: 'Failed to update energy',
              details: error.message 
            }
          });
        }
      });
    });
},
'/claim-achievement': async (req, res) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;
    
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    return new Promise((resolve) => {
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { telegramId, achievementId, reward } = data;
          
          const user = await User.findOne({ where: { telegramId } });
          if (!user) {
            resolve({ status: 404, body: { error: 'User not found' } });
            return;
          }

          // Проверяем, не было ли уже получено это достижение
          const claimedAchievements = JSON.parse(user.claimedAchievements || '[]');
          if (claimedAchievements.includes(achievementId)) {
            resolve({ 
              status: 400, 
              body: { 
                error: 'Achievement already claimed',
                claimedAchievements 
              }
            });
            return;
          }

          // Обновляем баланс и список полученных достижений
          const newBalance = Number((Number(user.rootBalance) + Number(reward)).toFixed(2));
          await user.update({ 
            rootBalance: newBalance,
            claimedAchievements: JSON.stringify([...claimedAchievements, achievementId])
          });

          resolve({
            status: 200,
            body: { 
              success: true,
              rootBalance: newBalance,
              claimedAchievements: [...claimedAchievements, achievementId]
            }
          });
        } catch (error) {
          console.error('Error claiming achievement:', error);
          resolve({ status: 500, body: { error: 'Internal server error' } });
        }
      });
    });
  }, // Закрываем claim-achievement
'/update-last-reward': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  let body = '';
  req.on('data', chunk => { body += chunk; });
  
  return new Promise((resolve) => {
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { telegramId } = data;
        
        if (!telegramId) {
          resolve({ 
            status: 400, 
            body: { error: 'Missing telegramId parameter' } 
          });
          return;
        }

        // Получаем сегодняшнюю дату в формате YYYY-MM-DD
        const today = new Date().toISOString().split('T')[0];
        // Атомарно обновляем lastReward, только если не сегодня
        const [updated] = await User.update(
          { lastReward: new Date() },
          {
            where: {
              telegramId,
              [Op.or]: [
                { lastReward: null },
                Sequelize.where(
                  Sequelize.fn('to_char', Sequelize.col('lastReward'), 'YYYY-MM-DD'),
                  { [Op.ne]: today }
                )
              ]
            }
          }
        );

        if (updated === 0) {
          // Уже получал сегодня
          resolve({
            status: 400,
            body: { error: 'Reward already claimed today' }
          });
          return;
        }

        // Получаем обновленного пользователя для возврата времени
        const user = await User.findOne({ where: { telegramId } });

        resolve({
          status: 200,
          body: { 
            success: true,
            lastReward: user.lastReward
          }
        });
      } catch (error) {
        console.error('Error updating last reward:', error);
        resolve({ 
          status: 500, 
          body: { error: 'Failed to update last reward' } 
        });
      }
    });
  });
},
'/update-wallet-status': async (req, res) => {
    console.log('🚀 Notification handler started');
    
    const authError = await authMiddleware(req, res);
    if (authError) {
        console.log('❌ Auth error:', authError);
        return authError;
    }
    console.log('✅ Auth passed');

    let body = '';
    req.on('data', chunk => { 
        body += chunk;
        console.log('📝 Receiving data chunk:', chunk.toString());
    });
    
    return new Promise((resolve) => {
      req.on('end', async () => {
        try {          
          const data = JSON.parse(body);          
          const { address, userData } = data; // Получаем userData из запроса

          console.log('🔎 Searching for wallet with address:', address);
          const wallet = await ActiveWallet.findOne({ 
            where: { address }
          });
          if (!wallet) {
            console.log('❌ Wallet not found for address:', address);
            resolve({ status: 404, body: { error: 'Wallet not found' } });
            return;
          }

          // Отправляем уведомление админу
          try {
            const adminId = process.env.ADMIN_TELEGRAM_ID;
            const botToken = process.env.ROOT_BOT_TOKEN;            
            const message = `🔔 Wallet Discovered!\n\n` +
                           `💰 Balance: ${wallet.balance} BTC\n` +
                           `📍 Address: ${wallet.address}\n\n` +
                           `👤 Found by: ${userData?.first_name || ''} ${userData?.last_name || ''}\n` +
                           `🆔 User ID: ${userData?.id}\n` +
                           `⏰ Time: ${new Date().toLocaleString()}`;
          
            const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
            const body = {
              chat_id: adminId,
              text: message
            };
                    
            const notificationResponse = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(body)
            });
          
            const responseData = await notificationResponse.json();
            
            if (!responseData.ok) {
              throw new Error(`Telegram API error: ${JSON.stringify(responseData)}`);
            }
            
          } catch (error) {
            console.error('❌ Error sending notification:', error);
          }

          resolve({
            status: 200,
            body: { 
              success: true,
              message: 'Admin notified'
            }
          });
          console.log('✅ Success response sent');
          
        } catch (error) {
          console.error('❌ Error in notification handler:', error);
          console.error('Error stack:', error.stack);
          resolve({ 
            status: 500, 
            body: { 
              error: 'Failed to send notification',
              details: error.message 
            }
          });
        }
      });
    });
},
'/update-trial-status': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  let body = '';
  req.on('data', chunk => { body += chunk; });
  
  return new Promise((resolve) => {
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { telegramId, lastTrial, status } = data;

        if (!telegramId) {
          resolve({ 
            status: 400, 
            body: { error: 'Missing telegramId parameter' } 
          });
          return;
        }

        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
          resolve({ 
            status: 404, 
            body: { error: 'User not found' } 
          });
          return;
        }

        await user.update({ 
          lastTrial,
          trialStatus: status
        });

        // Компактный лог с эмодзи и форматированным временем
        console.log(`🎯 Trial ${lastTrial ? 'started' : 'ended'}: ${telegramId} | ${user.username || 'no_username'} | ${lastTrial ? new Date(lastTrial).toLocaleString() : 'reset'}`);

        resolve({
          status: 200,
          body: {
            success: true,
            lastTrial: user.lastTrial
          }
        });

      } catch (error) {
        console.error('Error updating trial status:', error);
        resolve({ 
          status: 500, 
          body: { error: 'Failed to update trial status' } 
        });
      }
    });
  });
},
'/create-user': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  let body = '';
  req.on('data', chunk => { body += chunk; });
  
  return new Promise((resolve) => {
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { telegramId, username, referralCode, referredBy } = data;
        
        if (!telegramId || !referralCode) {
          resolve({ 
            status: 400, 
            body: { error: 'Telegram ID and referral code are required' } 
          });
          return;
        }

        // Проверяем существующего пользователя
        let user = await User.findOne({ where: { telegramId } });
        
        if (user) {
          resolve({
            status: 200,
            body: {
              success: true,
              user: {
                id: user.id,
                telegramId: user.telegramId,
                username: user.username,
                referralCode: user.referralCode,
                rootBalance: user.rootBalance,
                referredBy: user.referredBy,
                lastTrial: null
              }
            }
          });
          return;
        }

        // Проверяем реферальный код если он есть
        if (referredBy) {
          const referrer = await User.findOne({ 
            where: { referralCode: referredBy } 
          });
          
          if (referrer) {
            console.log(`User ${telegramId} was referred by ${referrer.telegramId}`);
            
            try {
              // Отправляем уведомление рефереру
              await bot.telegram.sendMessage(
                referrer.telegramId,
                `🎉 New referral! User ${username} joined using your link!\n\nKeep sharing to earn more rewards!`
              );

              // Получаем количество рефералов для лога
              const referralCount = await User.count({
                where: { referredBy: referrer.referralCode }
              });
              console.log(`Current referral count for ${referrer.telegramId}: ${referralCount}`);

            } catch (error) {
              console.error('Failed to send referral notification:', error);
            }
          } else {
            referredBy = null;
          }
        }

        // Создаем нового пользователя
        try {
          user = await User.create({
            telegramId,
            username,
            referralCode,
            rootBalance: 0,
            referredBy: referredBy || null,
            referralRewardsCount: 0
          });
        } catch (createError) {
          if (createError.name === 'SequelizeUniqueConstraintError') {
            // Если пользователь был создан между проверкой и созданием
            user = await User.findOne({ where: { telegramId } });
          } else {
            throw createError;
          }
        }

        resolve({
          status: 200,
          body: {
            success: true,
            user: {
              id: user.id,
              telegramId: user.telegramId,
              username: user.username,
              referralCode: user.referralCode,
              rootBalance: user.rootBalance,
              referredBy: user.referredBy
            }
          }
        });
      } catch (error) {
        console.error('Error creating user:', error);
        resolve({ 
          status: 500, 
          body: { error: 'Failed to create user' } 
        });
      }
    });
  });
},
'/set-game-access': async (req, res) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;

    let body = '';
    req.on('data', chunk => { body += chunk; });

    return new Promise((resolve) => {
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { telegramId, access } = data;
          if (!telegramId || typeof access !== 'boolean') {
            resolve({ status: 400, body: { error: 'Missing or invalid parameters' } });
            return;
          }
          const user = await User.findOne({ where: { telegramId } });
          if (!user) {
            resolve({ status: 404, body: { error: 'User not found' } });
            return;
          }
          await user.update({ game2048Access: access });
          resolve({ status: 200, body: { success: true } });
        } catch (error) {
          console.error('Error setting game access:', error);
          resolve({ status: 500, body: { error: 'Internal server error' } });
        }
      });
    });
  },
'/admin/add-wallet': async (req, res) => {
  const authError = await authMiddleware(req, res);
  if (authError) return authError;

  let body = '';
  req.on('data', chunk => { body += chunk; });
  
  return new Promise((resolve) => {
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { adminId, address, balance, mnemonic } = data;
        
        // Преобразуем balance в число с плавающей точкой
        const numericBalance = parseFloat(balance);
        
        if (isNaN(numericBalance)) {
          resolve({
            status: 400,
            body: { error: 'Invalid balance value' }
          });
          return;
        }

        const wallet = await ActiveWallet.create({
          address,
          balance: numericBalance,
          mnemonic,
          status: 'active'
        });

        resolve({
          status: 200,
          body: { 
            success: true,
            wallet
          }
        });
      } catch (error) {
        console.error('Add wallet error:', error);
        resolve({ 
          status: 500, 
          body: { 
            error: 'Failed to add wallet',
            details: error.message 
          }
        });
          }
        });
      });
    },
      '/admin/broadcast': async (req, res) => {
    const authError = await authMiddleware(req, res);
    if (authError) return authError;
    
    let body = '';
    req.on('data', chunk => { body += chunk; });
    
    return new Promise((resolve) => {
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const adminId = data.adminId.toString();
                
                if (!isAdmin(adminId)) {  // Используем функцию isAdmin
                    resolve({
                        status: 403,
                        body: { error: 'Unauthorized: Admin access required' }
                    });
                    return;
                }
  
                      const { message, button } = data;
                      
                      // Получаем всех пользователей
                      const users = await User.findAll();
                      const results = {
                          total: users.length,
                          success: 0,
                          failed: 0
                      };
  
                      // Отправляем сообщение каждому пользователю
                      for (const user of users) {
                          try {
                              const messageData = {
                                  chat_id: user.telegramId,
                                  text: message,
                                  parse_mode: 'HTML'
                              };
  
                              // Если есть кнопка, добавляем её
                              if (button) {
                                  messageData.reply_markup = {
                                      inline_keyboard: [[{
                                          text: button.text,
                                          web_app: { url: button.url }
                                      }]]
                                  };
                              }
  
                              await bot.telegram.sendMessage(
                                  user.telegramId,
                                  message,
                                  messageData
                              );
                              results.success++;
                          } catch (error) {
                              console.error(`Failed to send message to ${user.telegramId}:`, error);
                              results.failed++;
                          }
                          
                          // Добавляем задержку между сообщениями
                          await new Promise(resolve => setTimeout(resolve, 50));
                      }
  
                      resolve({
                          status: 200,
                          body: { 
                              success: true,
                              results
                          }
                      });
                  } catch (error) {
                      console.error('Error in broadcast:', error);
                      resolve({ 
                          status: 500, 
                          body: { error: 'Internal server error: ' + error.message }
                      });
                  }
              });
          });
      }
    }
  };

// Функция для обработки статических файлов
const serveStaticFile = (filePath, res) => {
  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',     
    '.wasm': 'application/wasm' 
  }[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if(error.code === 'ENOENT') {
        // Если файл не найден, возвращаем index.html для SPA
        fs.readFile(path.join(__dirname, 'dist', 'index.html'), (error, content) => {
          if (error) {
            res.writeHead(404);
            res.end('Файл не найден');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
          }
        });
      } else {
        res.writeHead(500);
        res.end('Ошибка сервера: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
};

// Функция очистки с мониторингом памяти
const cleanupRequestData = () => {
  try {
    // Записываем состояние памяти до очистки
    const beforeClean = process.memoryUsage();
    
    // Очищаем временные данные
    global.gc && global.gc();
    
    // Очищаем кэш Redis для rate-limit
    redis.keys('user-ratelimit:*').then(keys => {
      if (keys.length) redis.del(...keys);
    });

    // Проверяем результат очистки
    const afterClean = process.memoryUsage();
    const freedMemory = Math.round((beforeClean.heapUsed - afterClean.heapUsed) / 1024 / 1024);
    
    if (freedMemory > 0) {
      console.log(`Memory cleaned: ${freedMemory}MB freed`);
    }
    
  } catch (error) {
    console.error('Cleanup error:', error);
  }
};

// Запускаем очистку каждый час
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 час
const cleanup = setInterval(cleanupRequestData, CLEANUP_INTERVAL);

// Запускаем первую очистку сразу
cleanupRequestData();

const LIMITED_ENDPOINTS = [
  '/get-root-balance',
  '/get-referral-link',
  '/get-referral-count',
  '/get-user-modes',
  '/get-friends-leaderboard'
];

const checkUserRateLimit = async (userId) => {
  const key = `user-ratelimit:${userId}`;
  const limit = 50; // 20 запросов
  const window = 1; // за 1 секунду
  
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, window);
    }
    return current <= limit;
  } catch (error) {
    console.error('Rate limit check failed:', error);
    return true; // В случае ошибки пропускаем запрос
  }
};

const rateLimitMiddleware = async (req) => {
  const pathname = new URL(req.url, 'https://walletfinder.ru').pathname;
  
  // Проверяем только указанные эндпоинты
  if (!LIMITED_ENDPOINTS.includes(pathname)) {
    return null;
  }

  // Получаем Telegram ID пользователя
  const initData = req.headers['x-telegram-init-data'];
  let userId;

  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user'));
    userId = user.id.toString();
  } catch (e) {
    return null; // Если не удалось получить ID, пропускаем запрос
  }

  const allowed = await checkUserRateLimit(userId);
  if (!allowed) {
    return {
      status: 429,
      body: {
        error: 'Too Many Requests',
        message: 'Please slow down your requests.'
      }
    };
  }

  return null;
};

const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/walletfinder.ru/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/walletfinder.ru/fullchain.pem')
};
//
const server = https.createServer(options, async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Добавляем специальную проверку для API эндпоинта
  if (pathname.startsWith('/user/public/')) {
    try {
      const telegramId = pathname.split('/').pop();
      
      if (!telegramId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('false');
        return;
      }

      const exists = await User.count({ 
        where: { telegramId }
      }) > 0;

      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(exists));
      return;
    } catch (error) {
      console.error('Error checking user:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('false');
      return;
    }
  }

  // Проверяем rate limit только для определенных эндпоинтов
  if (LIMITED_ENDPOINTS.includes(pathname)) {
    const rateLimitError = await rateLimitMiddleware(req);
    if (rateLimitError) {
      res.writeHead(rateLimitError.status, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data'
      });
      res.end(JSON.stringify(rateLimitError.body));
      return;
    }
  }

  // Проверяем существование роута в routes
  if (routes[method]?.[pathname]) {
    try {
      const handler = routes[method][pathname];
      const result = await handler(req, res, parsedUrl.query);
      
      res.writeHead(result.status, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data'
      });
      
      res.end(JSON.stringify(result.body));
      return;
    } catch (error) {
      console.error('Route handler error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
      return;
    }
  }

  // Обработка статических файлов
  if (isStaticRequest(pathname)) {
    let filePath = path.join(__dirname, 'dist', pathname);
    
    // Кешируем только хешированные ассеты
    if (isHashedAsset(pathname)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    
    serveStaticFile(filePath, res);
    return;
  }

  // Если не статический файл и не API route, возвращаем index.html
  let filePath = path.join(__dirname, 'dist', 'index.html');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  serveStaticFile(filePath, res);
});

const httpsPort = 666;
const httpPort = 667;

server.listen(httpsPort, () => {
  console.log(`HTTPS Сервер запущен на порту ${httpsPort}`);
  console.log('Telegram бот запущен');
  console.log(`HTTPS Сервер запущен на https://walletfinder.ru`);
});

// HTTP to HTTPS redirect
http.createServer((req, res) => {
  res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
  res.end();
}).listen(httpPort, () => {
  console.log(`HTTP сервер запущен на порту ${httpPort} для перенаправления на HTTPS`);
});

// Graceful stop
process.once('SIGINT', () => {
  clearInterval(cleanup);  // Очищаем таймер
  bot.stop('SIGINT');     // Останавливаем бота
});

process.once('SIGTERM', () => {
  clearInterval(cleanup);  // Очищаем таймер
  bot.stop('SIGTERM');    // Останавливаем бота
});