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
		db: config.REDIS_DB || 0,
		...(config.REDIS_PASSWORD && { password: config.REDIS_PASSWORD }),
		tls: {rejectUnauthorized: false},
		maxRetriesPerRequest: null,
		connectTimeout: 30000,
        retryStrategy: function(times) {
                console.log(`Redis retry attempt ${times}`);
                return Math.min(times * 500, 10000);
        },
	},
};

const serverAdapter = new ExpressAdapter();

const client = redis.createClient({
	...redisConfig.redis,
	retryStrategy: (times) => {
		console.log(`Retrying Redis connection... Attempt ${times}`);
		return Math.min(times * 100, 3000);
	},
	enableReadyCheck: true,
	reconnectOnError: function(err) {
		console.error('Redis reconnectOnError:', err);
		return true;
	}
});

client.on('error', (err) => {
	console.error('Redis Client Error:', err);
});

client.on('connect', () => {
	console.log('Redis Client Connected');
});

client.on('ready', () => {
	console.log('Redis Client Ready');
});

client.on('reconnecting', () => {
	console.log('Redis Client Reconnecting');
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
	try {
		const {setQueues} = createBullBoard({queues: queueList, serverAdapter});
		console.log('Bull Board initialized with queues:', queueList.length);
		
		const router = serverAdapter.getRouter();
		console.log('Router initialized');

		const app = express();

		app.set('views', __dirname + '/views');
		app.set('view engine', 'ejs');

		if (app.get('env') !== 'production') {
			const morgan = require('morgan');
			app.use(morgan('combined'));
		}

		// Add error handling middleware
		app.use((err, req, res, next) => {
			console.error('Express error:', err);
			res.status(500).send('Internal Server Error');
		});

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
			console.log('Authentication enabled, setting up auth routes');
			app.use(config.LOGIN_PAGE, authRouter);
			app.use(config.HOME_PAGE, ensureLoggedIn(config.LOGIN_PAGE), router);
		} else {
			console.log('Authentication disabled, setting up public routes');
			app.use(config.HOME_PAGE, router);
		}

		// Add a health check endpoint
		app.get('/health', (req, res) => {
			res.status(200).send('OK');
		});

		const server = app.listen(config.PORT, () => {
			console.log(`Server started successfully on port ${config.PORT}`);
			console.log(`Bull-board URL: http://localhost:${config.PORT}${config.HOME_PAGE}`);
			console.log(`Health check URL: http://localhost:${config.PORT}/health`);
		});

		server.on('error', (error) => {
			console.error('Server error:', error);
		});

	} catch (error) {
		console.error('Failed to initialize application:', error);
		process.exit(1);
	}
}).catch(error => {
	console.error('Failed to initialize queues:', error);
	process.exit(1);
});
