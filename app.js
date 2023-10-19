require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const mysql = require('mysql2/promise');

// create LINE SDK config from env variables
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

// create Express app
// about Express itself: https://expressjs.com/
const app = express();

// upTimeRobot 用來監控伺服器是否正常運作
app.get('/healthcheck', (req, res) => {
    res.send('OK');
});

// register a webhook handler with middleware
// about the middleware, please refer to doc
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

// event handler
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        // ignore non-text-message event
        return Promise.resolve(null);
    }
    const profile = await client.getProfile(event.source.userId);
    console.log(profile.displayName);
    console.log(profile.userId);
    console.log(profile.pictureUrl);
    console.log(profile.statusMessage);

    let echo = '';
    // 做一個檢查用戶 id 與資料庫是否 type 已經有 乘客或司機 ，撈出那個用戶做+-動作
    if (event.message.text === '我是乘客') {
        echo = {type: 'text', text: `${profile.displayName} ，我已經將您切換為 乘客 !`};
    } else if (event.message.text === '我是司機') {
        echo = {type: 'text', text: `${profile.displayName} ，我已經將您切換為 司機 !`};

        const [rows, fields] = await pool.execute('INSERT INTO users (line_user_id, line_user_name, line_user_type) VALUES (?, ?, ?)', [profile.userId, profile.displayName, '司機']);
    } else {
        echo = {type: 'text', text: `嗨~ ${profile.displayName} ，我重複一次你的問題: ${event.message.text}`};
    }
    // use reply API
    return client.replyMessage(event.replyToken, echo);
}

// listen on port
const port = process.env.PORT || 3000;
// 預設的錯誤處理器
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('伺服器忙碌中，請稍後重試');
});
app.listen(port, () => {
    console.log(`listening on ${port}`);
});
