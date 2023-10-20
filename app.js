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
    queueLimit: 0,
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

// =========================== 主要事件處理處 ===========================
// ============= data =============
const FUNCTIONS_MAP = {
    乘客: {
        車費匯款: fareTransfer,
        車費查詢: fareSearch,
        // 可以根據需求繼續新增功能
    },
    司機: {
        車費計算表: fareIncome,
        // 可以根據需求繼續新增功能
    },
};
let echo = {}; // Bot 回傳提示字

// ============= 共用函式 =============
// 驗證用戶是否存在於資料庫
async function validateUser(profile, event) {
    const [existingUsers] = await executeSQL(
        'SELECT * FROM users WHERE line_user_id = ?',
        [profile.userId]
    );
    let type = '';
    let user = null;

    if (existingUsers.length > 0 && event.message.text !== '77') {
        type = 'existing_user'; // 原有用戶
        user = existingUsers[0];
        if ((existingUsers[0].line_user_type === '乘客' && event.message.text === '我是司機') ||
            (existingUsers[0].line_user_type === '司機' && event.message.text === '我是乘客')) {
            type = 'repeat_command'; // 重複寫入
        }
    } else if (existingUsers.length === 0 && (event.message.text === '我是乘客' || event.message.text === '我是司機')) {
        type = 'create_user'; // 創新戶
    } else if (event.message.text === '77') {
        type = 'super_user'; // 技術支援
    } else {
        type = 'wrong_command'; // 未依規則指令
    }

    return {
        user: user,
        type: type,
    };
}

// 共用回傳訊息格式
function createResponse(type, message) {
    echo = {type: type, text: message};
}

// ============= SQL函式處 =============
// SQL 專用 function
async function executeSQL(query, params) {
    try {
        const [rows, fields] = await pool.execute(query, params);
        return [rows, fields];
    } catch (error) {
        createResponse('text', '資料異常請聯絡開發人員');
        console.error('SQL Error:', error);
        throw error;
    }
}

// 新建用戶
async function handleUserTypeChange(profile, userType) {
    await executeSQL(
        'INSERT INTO users (line_user_id, line_user_name, line_user_type) VALUES (?, ?, ?)',
        [profile.userId, profile.displayName, userType]
    );
}

// ============= 對應指令功能 =============
// 乘客-車費匯款的操作
async function fareTransfer(profile, event) {
    // 正規表達式修改為匹配「車費匯款:」後，第一個數字為1-9，後續可以是0-9的數字
    const fareMatch = event.message.text.match(/^車費匯款:([1-9][0-9]*)$/);

    if (fareMatch) {
        const fareAmount = Number(fareMatch[1]);
        await executeSQL(
            'INSERT INTO fare (line_user_id, user_fare) VALUES (?, ?)',
            [profile.userId, fareAmount]
        );
        createResponse('text', `${profile.displayName} ，您的車費 NT$${fareAmount} 已被記錄。`);
    } else {
        createResponse('text', `${profile.displayName} ，請輸入正確格式 範例: (車費匯款:1200)`);
    }
}

// 乘客-車費查詢的操作
async function fareSearch(profile) {
    const [userFare] = await executeSQL(
        'SELECT user_fare FROM fare WHERE line_user_id = ?',
        [profile.userId]
    );
    // 4. 檢查查詢結果
    if (userFare.length === 0) {
        createResponse('text', `${profile.displayName} ，您尚未有車費紀錄。`);
    } else {
        const fare = userFare[0].user_fare;
        createResponse('text', `${profile.displayName} ，您目前的車費為 NT$${fare}。`);
    }
}

// 司機-顯示司機的車費計算表
async function fareIncome(profile) {
    // 1. 執行SQL查詢來獲取所有的user_fare的總和
    const [result] = await executeSQL(
        'SELECT SUM(user_fare) AS total_income FROM fare'
    );

    // 2. 檢查查詢結果
    if (!result[0] || result[0].total_income === null) {
        createResponse('text', `目前尚無車費紀錄。`);
    } else {
        const totalIncome = result[0].total_income;
        createResponse('text', `目前的總車費收入為 NT$${totalIncome}。`);
    }
}

// event handler
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        // ignore non-text-message event
        return Promise.resolve(null);
    }

    const profile = await client.getProfile(event.source.userId); // 用戶資料
    const validationResult = await validateUser(profile, event); // 初始 ID 驗證
    let userType = '';

    if (validationResult.type === 'existing_user') {
        const userLineType = validationResult.user.line_user_type;
        const userFunction = FUNCTIONS_MAP[userLineType][event.message.text];
        const fareTransferMatch = event.message.text.includes('車費匯款:');

        if (userFunction) {
            await userFunction(profile, event);// 正確指令執行對應的功能
        } else if (fareTransferMatch) {
            await fareTransfer(profile, event); // 車費匯款特別處理
        } else {
            if (userLineType) {
                const functionNames = Object.keys(FUNCTIONS_MAP[userLineType]);// 擷取功能名稱
                const functionNamesString = functionNames.join('、');// 組成功能名稱的字串，例如: "車費匯款、車費查詢"

                // 組合整體訊息
                createResponse('text', `${userLineType} ${profile.displayName} 歡迎回來，請問需要什麼服務嗎? 指令有: ${functionNamesString}。`);
            } else {
                createResponse('text', '檢測資料異常，請聯絡開發人員!');
            }
        }
    } else if (validationResult.type === 'create_user') {
        userType = event.message.text === '我是乘客' ? '乘客' : '司機';
        await handleUserTypeChange(profile, userType);
        createResponse('text', `${profile.displayName} ，我已經將您切換為 ${userType} !`);
    } else if (validationResult.type === 'repeat_command') {
        createResponse('text', '如需切換使用者請聯絡開發人員');
    } else if (validationResult.type === 'super_user') {
        createResponse('text', '嗨! 我是開發者 77 這是我的 LINE ID: 0925955648，如果你真的需要我的幫助，請再聯繫我 !');
    } else {
        createResponse('text', '請先依照身分輸入(我是乘客) 或 (我是司機) 加入。');
    }

    // use reply API
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
