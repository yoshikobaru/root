const https = require('https');  
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const crypto = require('crypto');
require('dotenv').config();
const { Sequelize, DataTypes } = require('sequelize');
const url = require('url');


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
const schedule = require('node-schedule');
const isAdmin = (telegramId) => {
  return telegramId.toString() === ADMIN_ID;
};

// Создаем подключение к базе данных
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD, 
  {
      host: process.env.DB_HOST,
      dialect: process.env.DB_DIALECT
  }
);

// Определяем модель User
const User = sequelize.define('User', {
  telegramId: {
    type: DataTypes.BIGINT, // Изменить тип с STRING на BIGINT
    allowNull: false,
    unique: true
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true
  },
  referralCode: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
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
    defaultValue: 0
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
  lastAdWatchTime: {
    type: DataTypes.DATE,
    allowNull: true
  }
});

// Синхронизируем модель с базой данных
sequelize.sync({ alter: true });
// Создаем экземпляр бота с вашим токеном
const bot = new Telegraf(process.env.ROOT_BOT_TOKEN);
// WebApp URL
const webAppUrl = 'https://walletfinder.ru';

// Обработчик команды /start
bot.command('start', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  // Используем first_name если username отсутствует
  const username = ctx.from.username || ctx.from.first_name || `user_${telegramId}`;
  const referralCode = ctx.message.text.split(' ')[1];

  try {
    let user = await User.findOne({ where: { telegramId } });

    if (!user) {
      const newReferralCode = crypto.randomBytes(4).toString('hex');
      
      user = await User.create({
        telegramId,
        username,
        referralCode: newReferralCode,
        referredBy: referralCode || null
      });

      if (referralCode) {
        const referrer = await User.findOne({ where: { referralCode } });
        if (referrer) {
          console.log(`User ${telegramId} was referred by ${referrer.telegramId}`);
        }
      }
    } else {
      // Обновляем username если он изменился
      if (user.username !== username) {
        await user.update({ username });
      }
      
      // Если пользователь уже существует, но не имеет реферера и предоставлен реферальный код
      if (!user.referredBy && referralCode) {
        const referrer = await User.findOne({ where: { referralCode } });
        if (referrer && referrer.telegramId !== telegramId) { // Проверяем что это не самореферал
          await user.update({ referredBy: referralCode });
          console.log(`Existing user ${telegramId} was referred by ${referrer.telegramId}`);
        }
      }
    }

    ctx.reply('🌐 Welcome to $_root@btc 💻\n\n' + 
      '🔄 Lost Bitcoin wallets recovery app powered by:\n' +
      '⚡️ Blockchain API\n' +
      '🔗 BTC Network Integration\n' +
      '🔐 Advanced cryptographic algorithms\n\n' +
      '💰 Earn $ROOT tokens while searching:\n' +
      '📈 Mining rewards for each attempt\n' +
      '🎯 Bonus for successful recovery\n' +
      '✨ Coming soon:\n' +
      '📊 $ROOT Token Trading\n' +
      '💫 Major DEX Listings\n' +
      '🌟 Staking & Farming\n\n' +
      '🚀 Ready to start your recovery journey?\n' +
      '👉 Open Web App to begin:', {
      reply_markup: {
        resize_keyboard: true
      }
    });

  } catch (error) {
    console.error('Error in start command:', error);
    ctx.reply('An error occurred. Please try again later.');
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
    const payment = ctx.message.successful_payment;
    const [type, telegramId, modeName] = payment.invoice_payload.split('_');

    if (type === 'mode') {
      const user = await User.findOne({ where: { telegramId } });
      if (!user) {
        console.error('User not found:', telegramId);
        return;
      }

      // Добавляем новый режим
      const updatedModes = [...new Set([...user.purchasedModes, modeName])];
      await user.update({ purchasedModes: updatedModes });

      await ctx.reply('✨ Mode upgraded successfully! You can now use the new mode.');
    }
  } catch (error) {
    console.error('Error in successful_payment:', error);
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

const routes = {
  GET: {
    '/get-user': async (req, res, query) => {
  const telegramId = query.telegramId;
  
  if (!telegramId) {
    return { 
      status: 400, 
      body: { error: 'Telegram ID is required' } 
    };
  }

  try {
    let user = await User.findOne({ where: { telegramId } });
    
    if (user) {
      // Проверяем наличие реферального кода
      if (!user.referralCode) {
        const newReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        await user.update({ referralCode: newReferralCode });
        user = await User.findOne({ where: { telegramId } }); // Получаем обновленного пользователя
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
            referredBy: user.referredBy
          }
        }
      };
    }

    return { 
      status: 404, 
      body: { 
        success: false,
        error: 'User not found' 
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
    '/get-root-balance': async (req, res, query) => {
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
    '/get-referral-count': async (req, res, query) => {
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

    // Вычисляем статистику для фронтенда
    const rewardsEarned = Math.floor(referralCount / 3);
    const nextRewardAt = (rewardsEarned + 1) * 3;

    return { 
      status: 200, 
      body: { 
        success: true,
        count: referralCount,
        rewardsEarned,
        nextRewardAt
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
    const { telegramId, modeName } = query;
    
    if (!telegramId || !modeName) {
        return { status: 400, body: { error: 'Missing required parameters' } };
    }

    const modePrices = {
        'basic': 100,
        'advanced': 250,
        'expert': 500
    };

    try {
        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
            return { status: 404, body: { error: 'User not found' } };
        }

        if (user.purchasedModes.includes(modeName)) {
            return { status: 400, body: { error: 'Mode already purchased' } };
        }

        const invoice = await bot.telegram.createInvoiceLink({
            title: 'ROOTBTC Mode Upgrade',
            description: `Upgrade to ${modeName.charAt(0).toUpperCase() + modeName.slice(1)} mode`,
            payload: `mode_${telegramId}_${modeName}`,
            provider_token: "",
            currency: 'XTR',
            prices: [{
                label: '⭐️ Mode Upgrade',
                amount: parseInt(modePrices[modeName]) // Исправлено здесь
            }]
        });

        return { status: 200, body: { slug: invoice } };
    } catch (error) {
        console.error('Error creating mode invoice:', error);
        return { status: 500, body: { error: 'Failed to create invoice' } };
    }
},
    '/update-user-modes': async (req, res, query) => {
    const { telegramId, modeName } = query;
    
    if (!telegramId || !modeName) {
        return { status: 400, body: { error: 'Missing required parameters' } };
    }

    try {
        const user = await User.findOne({ where: { telegramId } });
        if (!user) {
            return { status: 404, body: { error: 'User not found' } };
        }

        const updatedModes = [...new Set([...user.purchasedModes, modeName])];
        await user.update({ purchasedModes: updatedModes });

        return { 
            status: 200, 
            body: { 
                success: true,
                purchasedModes: updatedModes
            }
        };
    } catch (error) {
        console.error('Error updating user modes:', error);
        return { status: 500, body: { error: 'Failed to update user modes' } };
    }
},

    '/get-user-modes': async (req, res, query) => {
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
                purchasedModes: user.purchasedModes 
            }
        };
    } catch (error) {
        console.error('Error getting user modes:', error);
        return { status: 500, body: { error: 'Failed to get user modes' } };
    }
},
    '/get-friends-leaderboard': async (req, res, query) => {
    const telegramId = query.telegramId;
    
    if (!telegramId) {
        return { status: 400, body: { error: 'Missing telegramId parameter' } };
    }

    try {
        // Получаем текущего пользователя
        const currentUser = await User.findOne({ 
            where: { telegramId },
            attributes: ['telegramId', 'username', 'highScore']
        });

        if (!currentUser) {
            return { status: 404, body: { error: 'User not found' } };
        }

        // Получаем топ-100 игроков с наивысшими рекордами
        const topPlayers = await User.findAll({
          where: {
              highScore: {
                  [Sequelize.Op.gt]: 0
              }
          },
          attributes: ['telegramId', 'username', 'highScore'],
          order: [['highScore', 'DESC']],
          limit: 50  // Уменьшаем лимит до 50
      });

        // Преобразуем данные
        const leaderboardData = topPlayers.map(player => ({
            id: player.telegramId,
            username: player.username,
            highScore: player.highScore,
            isCurrentUser: player.telegramId === telegramId
        }));

        // Если текущий пользователь не в топ-100, добавляем его отдельно
        if (!leaderboardData.some(player => player.isCurrentUser)) {
            leaderboardData.push({
                id: currentUser.telegramId,
                username: currentUser.username,
                highScore: currentUser.highScore,
                isCurrentUser: true
            });
        }

        return { 
            status: 200, 
            body: { 
                leaderboard: leaderboardData,
                timestamp: Date.now()
            } 
        };
    } catch (error) {
        console.error('Error getting leaderboard:', error);
        return { status: 500, body: { error: 'Internal server error' } };
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
                referredBy: user.referredBy
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

              // Получаем количество рефералов
              const referralCount = await User.count({
                where: { referredBy: referrer.referralCode }
              });

              // Проверяем, нужно ли выдать награду
              const newRewardsCount = Math.floor(referralCount / 3);
              const currentRewardsCount = referrer.referralRewardsCount || 0;

              if (newRewardsCount > currentRewardsCount) {
                // Вычисляем количество новых наград
                const rewardsToGive = newRewardsCount - currentRewardsCount;
                const rewardAmount = rewardsToGive * 0.5;

                // Обновляем баланс и счетчик наград реферера
                await referrer.update({
                  rootBalance: Number((referrer.rootBalance + rewardAmount).toFixed(2)),
                  referralRewardsCount: newRewardsCount
                });

                // Отправляем уведомление о награде
                await bot.telegram.sendMessage(
                  referrer.telegramId,
                  `🎯 Congratulations! You've earned ${rewardAmount} ROOT for inviting ${rewardsToGive * 3} friends!\n\nKeep inviting to earn more!`
                );
              }

            } catch (error) {
              console.error('Failed to process referral rewards:', error);
            }
          } else {
            referredBy = null;
          }
        }

        // Создаем нового пользователя
        user = await User.create({
          telegramId,
          username,
          referralCode,
          rootBalance: 0,
          referredBy: referredBy || null,
          referralRewardsCount: 0
        });

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

const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/walletfinder.ru/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/walletfinder.ru/fullchain.pem')
};
//
const server = https.createServer(options, async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (routes[method] && routes[method][pathname]) {
    const handler = routes[method][pathname];
    const result = await handler(req, res, parsedUrl.query);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } else {
    let filePath = path.join(__dirname, 'dist', req.url === '/' ? 'index.html' : req.url);
    serveStaticFile(filePath, res);
  }
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
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));