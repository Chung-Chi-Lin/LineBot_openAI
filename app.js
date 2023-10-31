require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
// const mysql = require('mysql2/promise');
const sql = require('mssql');
// create LINE、SQL SDK config from env variables
const config = {
	channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
	channelSecret: process.env.CHANNEL_SECRET,
};

const pool = new sql.ConnectionPool({
	server: process.env.DB_HOST,
	port: 1433,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME,
	options: {
		encrypt: true, // 使用Azure SQL，這是必需的
	}
});
console.log("測試", process.env.DB_HOST, process.env.DB_USER, process.env.DB_PASS, process.env.DB_NAME);
pool.connect()
		.then(() => {
			console.log('Connected to the database.');
		})
		.catch(err => {
			console.error('Database connection error:', err.message);
			console.error('Detailed error:', err);
		});

// create LINE SDK client
const client = new line.Client(config);

// ============= create Express app =============
// about Express itself: https://expressjs.com/
const app = express();

// upTimeRobot 用來監控伺服器是否正常運作
app.get('/healthcheck', (req, res) => {
	res.send('OK');
});

// register a webhook handler with middleware
app.post('/callback', line.middleware(config), (req, res) => {
	Promise.all(req.body.events.map(handleEvent))
			.then((result) => res.json(result))
			.catch((err) => {
				console.error(err);
				// 回應 LINE 用戶一個錯誤訊息
				const errorMessage = {
					type: 'text',
					text: '資料處理中，請稍後重試',
				};
				return client
						.replyMessage(req.body.events[0].replyToken, errorMessage)
						.then(() => {
							res.status(500).end();
						});
			});
});

// ============= SQL函式處 =============
// SQL 專用 function
async function executeSQL(query, params) {
	try {
		const [rows, fields] = await pool.query(query, params);
		return [rows, fields];
	} catch (error) {
		createResponse('text', '資料異常請聯絡開發人員');
		console.error('SQL Error:', error);
		throw error;
	}
}
// 共用-回傳訊息格式
function createResponse(type, message) {
	echo = {type: type, text: message};
}
// 新建用戶
async function handleUserTypeChange(profile, userType) {
	await executeSQL(
			'INSERT INTO users (line_user_id, line_user_name, line_user_type) VALUES (?, ?, ?)',
			[profile.userId, profile.displayName, userType]
	);
}

// 主要處理指令函式
async function handleEvent(event) {
	if (event.type !== 'message' || event.message.type !== 'text') {
		// ignore non-text-message event
		return Promise.resolve(null);
	}

	const profile = await client.getProfile(event.source.userId); // 用戶資料
	createResponse(
			'text',
			`${profile}`
	);

	return client.replyMessage(event.replyToken, echo);
}

// ============= listen on port =============
const port = process.env.PORT || 3000;
// 預設的錯誤處理器
app.use((err, req, res, next) => {
	console.error(err.stack);
	res.status(500).send('伺服器忙碌中，請稍後重試');
});
app.listen(port, () => {
	console.log(`listening on ${port}`);
});
