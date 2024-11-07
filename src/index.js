const {createBullBoard} = require('@bull-board/api');
const {BullAdapter} = require('@bull-board/api/bullAdapter');
const {BullMQAdapter} = require('@bull-board/api//bullMQAdapter');
const {ExpressAdapter} = require('@bull-board/express');
const Queue = require('bull');
const bullmq = require('bullmq');
const express = require('express');
const redis = require('ioredis');
const session = require('express-session');
const passport = require('passport');
const {ensureLoggedIn} = require('connect-ensure-login');
const bodyParser = require('body-parser');
const RedisStore = require('connect-redis')(session);

const {authRouter} = require('./login');
const config = require('./config');

const redisConfig = {
	redis: {
		port: config.REDIS_PORT,
		host: config.REDIS_HOST,
		...(config.REDIS_PASSWORD && {db: config.REDIS_DB, password: config.REDIS_PASSWORD}),
		// tls: config.REDIS_USE_TLS === 'true',
	},
};

const serverAdapter = new ExpressAdapter();

const client = redis.createClient({...redisConfig.redis, retryStrategy: (times) => {
    console.log(`Retrying Redis connection... Attempt ${times}`);
    return Math.min(times * 100, 3000);
  }});
// client.connect().catch(console.error); 
client.on('error', (err) => {
	console.error('Redis Client Error', err);
  });
  
  client.on('connect', () => {
	console.log('Redis Client Connected');
  });
  
  client.on('ready', () => {
	console.log('Redis Client Ready');
  });

async function initializeQueueList() {

	try {
		// await client.connect();
		const keys = await client.keys(`${config.BULL_PREFIX}:*`);

		const uniqKeys = new Set(keys.map(key => key.replace(/^.+?:(.+?):.+?$/, '$1')));
		const queueList = Array.from(uniqKeys).sort().map(
			(item) => {
				
				if (config.BULL_VERSION === 'BULLMQ') {
					const options = { connection: redisConfig.redis };
					if (config.BULL_PREFIX) {
						options.prefix = config.BULL_PREFIX;
					}
					return new BullMQAdapter(new bullmq.Queue(item, options));
				}
				return new BullAdapter(new Queue(item, redisConfig.redis));
			}
		);
		console.log('queueList', queueList);
		// setQueues(queueList);
		console.log('done!');
		return queueList; // Return the queueList
	} catch (err) {
		console.error('Error fetching keys:', err);
		return []; // Return an empty array in case of error
	}
}

// Call the function and use the returned queueList
initializeQueueList().then(async (queueList) => {

	const {setQueues} = createBullBoard({queues: queueList, serverAdapter});
	console.log('setQueues', setQueues);
	const router = serverAdapter.getRouter();

	const app = express();

	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');

	if (app.get('env') !== 'production') {
		const morgan = require('morgan');
		app.use(morgan('combined'));
	}

	app.use((req, res, next) => {
		if (config.PROXY_PATH) {
			req.proxyUrl = config.PROXY_PATH;
		}

		next();
	});

	const sessionOpts = {
		name: 'bull-board.sid',
		secret: Math.random().toString(),
		resave: false,
		saveUninitialized: false,
		store: new RedisStore({ client: client }),
		cookie: {
			path: '/',
			httpOnly: false,
			secure: false
		}
	};

	app.use(session(sessionOpts));
	app.use(passport.initialize({}));
	app.use(passport.session({}));
	app.use(bodyParser.urlencoded({extended: false}));

	if (config.AUTH_ENABLED) {
		app.use(config.LOGIN_PAGE, authRouter);
		app.use(config.HOME_PAGE, ensureLoggedIn(config.LOGIN_PAGE), router);
	} else {
		app.use(config.HOME_PAGE, router);
	}

	app.listen(config.PORT, () => {
		console.log(`bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`);
		console.log(`bull-board is fetching queue list, please wait...`);
	});
});
