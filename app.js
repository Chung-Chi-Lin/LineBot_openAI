require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const mysql = require('mysql2/promise');

// create LINE、SQL SDK config from env variables
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// create LINE SDK client
const client = new line.Client(config);

// === create Express app ===
// about Express itself: https://expressjs.com/
const app = express();

// upTimeRobot 用來監控伺服器是否正常運作
app.get('/healthcheck', (req, res) => {
    res.send('OK');
});

// register a webhook handler with middleware
app.post('/callback', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            // 回應 LINE 用戶一個錯誤訊息
            const errorMessage = {
                type: 'text',
                text: '伺服器忙碌中，請稍後重試'
            };
            return client.replyMessage(req.body.events[0].replyToken, errorMessage)
                .then(() => {
                    res.status(500).end();
                });
        });
});

// === 主要事件處理處 ===
// SQL 專用 function
async function executeSQL(query, params) {
    try {
        const [rows, fields] = await pool.execute(query, params);
        return [rows, fields];
    } catch (error) {
        console.error('SQL Error:', error);
        throw error;
    }
}

// LINE 回傳提示字 function
function createEchoMessage(profileName, userType) {
    let messageText = `嗨~ ${profileName} ，我重複一次你的問題: `;
    if (userType === '乘客' || userType === '司機') {
        messageText = `${profileName} ，我已經將您切換為 ${userType} !`;
    }
    return {type: 'text', text: messageText};
}

// event handler
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        // ignore non-text-message event
        return Promise.resolve(null);
    }
    const profile = await client.getProfile(event.source.userId);

    let userType = '';
    if (event.message.text === '我是乘客') {
        userType = '乘客';
    } else if (event.message.text === '我是司機') {
        userType = '司機';
    }

    if (userType) {
        await executeSQL('INSERT INTO users (line_user_id, line_user_name, line_user_type) VALUES (?, ?, ?)', [profile.userId, profile.displayName, userType]);
    }

    const echo = createEchoMessage(profile.displayName, userType || event.message.text);
    // use reply API
    return client.replyMessage(event.replyToken, echo);
}

// === listen on port ===
const port = process.env.PORT || 3000;
// 預設的錯誤處理器
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('伺服器忙碌中，請稍後重試');
});
app.listen(port, () => {
    console.log(`listening on ${port}`);
});
