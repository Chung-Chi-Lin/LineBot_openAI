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
const COMMANDS_MAP = {
  乘客: {
    車費匯款: {
      function: fareTransfer,
      remark: '先行匯款後輸入之金額紀錄 (輸入範例: 車費匯款:1200)',
    },
    車費查詢: {
      function: fareSearch,
      remark:
        '確認加減原匯款金額之剩餘費用，例如:未搭車或多搭乘 (輸入範例: 車費查詢)',
    },
    綁定搭乘司機: {
      function: bindDriverId,
      remark: '綁定搭乘司機後方可計算日後車費 (輸入範例: 綁定搭乘司機:司機ID)',
    },
    // 可以根據需求繼續新增功能
  },
  司機: {
    車費計算表: {
      function: fareIncome,
      remark: '取得"目前乘客名稱與所得費用" (輸入範例: 車費計算表)',
    },
    乘客資訊: {
      function: userInformation,
      remark:
        '取得"目前乘客名稱與更改資訊ID，ID為需要修改資訊時才會使用到" (輸入範例: 乘客資訊)',
    },
    // 可以根據需求繼續新增功能
  },
};
let echo = {}; // Bot 回傳提示字

// ============= 共用函式 =============
// 驗證用戶是否存在於資料庫
async function validateUser(profile, event) {
  // 是否有 ID 在資料庫
  const [existingUsers] = await executeSQL(
    'SELECT * FROM users WHERE line_user_id = ?',
    [profile.userId]
  );
  let type = '';
  let user = null;

  if (existingUsers.length > 0 && event.message.text !== '77') {
    type = 'existing_user'; // 原有用戶
    user = existingUsers[0];
    if (
      (existingUsers[0].line_user_type === '乘客' &&
        event.message.text === '我是司機') ||
      (existingUsers[0].line_user_type === '司機' &&
        event.message.text === '我是乘客')
    ) {
      type = 'repeat_command'; // 重複寫入
    }
  } else if (
    existingUsers.length === 0 &&
    (event.message.text === '我是乘客' || event.message.text === '我是司機')
  ) {
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

// 指令共用格式
function getCommandsAsString(userType) {
  const commands = Object.entries(COMMANDS_MAP[userType]).map(
    ([key, value]) => ` > ${key}: ${value.remark}`
  );
  return `指令為:\n ${commands.join('。\n')}。`;
}

// 共用儲存SQL日期格式
function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0'); //January is 0!
  const yyyy = date.getFullYear();

  return `${yyyy}-${mm}-${dd}`;
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
  const fareMatch = event.message.text.match(
    /^車費匯款[:：]?\s*([1-9][0-9]*)$/
  );

  if (!fareMatch) {
    return createResponse(
      'text',
      `${profile.displayName} ，請輸入正確格式 範例: (車費匯款:1200)`
    );
  }

  const fareAmount = Number(fareMatch[1]);
  const result = await executeSQL(
    'SELECT user_fare, update_time FROM fare WHERE line_user_id = ? AND update_time = (SELECT update_time FROM fare WHERE line_user_id = ? ORDER BY ABS(DATEDIFF(update_time, CURDATE())) ASC LIMIT 1)',
    [profile.userId, profile.userId]
  );

  const fareData = result[0] && result[0][0];
  const currentDate = new Date();

  if (fareData) {
    const lastUpdateTime = new Date(fareData.update_time);
    const isSameMonth =
      lastUpdateTime.getMonth() === currentDate.getMonth() &&
      lastUpdateTime.getFullYear() === currentDate.getFullYear();

    if (isSameMonth) {
      return createResponse(
        'text',
        `${profile.displayName} ，您本月已經匯款 NT$${fareData.user_fare}。\n如欠費請下月匯款或請司機收到款項後再修改您的匯款紀錄。`
      );
    }
  }

  await executeSQL(
    'INSERT INTO fare (line_user_id, user_fare, update_time) VALUES (?, ?, ?)',
    [profile.userId, fareAmount, formatDate(currentDate)]
  );

  return createResponse(
    'text',
    `${profile.displayName} ，您的車費 NT$${fareAmount} 已被記錄。`
  );
}

// 乘客-車費查詢的操作
async function fareSearch(profile) {
  const [userFare] = await executeSQL(
    'SELECT user_fare FROM fare WHERE line_user_id = ? ORDER BY ABS(DATEDIFF(update_time, CURDATE())) ASC LIMIT 1',
    [profile.userId]
  );

  // 4. 檢查查詢結果
  if (userFare.length === 0) {
    createResponse('text', `${profile.displayName} ，您尚未有車費紀錄。`);
  } else {
    const fare = userFare[0].user_fare;
    createResponse(
      'text',
      `${profile.displayName} ，您最近的車費為 NT$${fare}。`
    );
  }
}

// 乘客-綁定司機的操作
async function bindDriverId(profile, event) {
  // 1. 擷取輸入的司機ID
  const driverMatch = event.message.text.match(/^綁定搭乘司機[:：]?\s*(.*)$/);

  if (driverMatch) {
    const driverId = driverMatch[1]; // 取得司機ID

    // 2. 檢查此ID是否存在於 users 表，且該用戶為司機
    const [driverData] = await executeSQL(
      'SELECT line_user_id FROM users WHERE line_user_id = ? AND line_user_type = "司機"',
      [driverId]
    );

    if (driverData.length === 0) {
      createResponse(
        'text',
        `${profile.displayName} ，您輸入錯誤司機ID 請於上方訊息查看司機ID。`
      );
    } else {
      // 3. 更新使用者的 line_user_driver 欄位
      await executeSQL(
        'UPDATE users SET line_user_driver = ? WHERE line_user_id = ?',
        [driverId, profile.userId]
      );
      createResponse('text', `${profile.displayName} ，您已成功綁定司機ID。`);
    }
  } else {
    createResponse(
      'text',
      `${profile.displayName} ，請輸入正確格式，範例: "綁定搭乘司機:Ue3fb7c1d55c6034e50a54630a3afe02c"。`
    );
  }
}

// 司機-顯示司機的乘客車費計算表
async function fareIncome(profile) {
  // 1. 執行SQL查詢來獲取特定司機的所有乘客的車費紀錄
  const [result] = await executeSQL(
    `SELECT u.line_user_name, f.user_fare, DATE_FORMAT(f.update_time, '%Y-%m-%d') AS formatted_date
        FROM fare AS f
        JOIN users AS u ON f.line_user_id = u.line_user_id
        WHERE u.line_user_driver = ?`,
    [profile.userId]
  );

  // 2. 檢查查詢結果
  if (result.length === 0) {
    createResponse('text', `目前尚無車費紀錄。`);
  } else {
    let responseText = '目前的車費計算表為：\n';
    result.forEach((entry) => {
      responseText += `${entry.line_user_name} : NT$${entry.user_fare}，匯款時間為 ${entry.formatted_date}\n`;
    });
    createResponse('text', responseText);
  }
}

// 司機-顯示乘客資訊
async function userInformation(profile) {
  // 1. 執行SQL查詢來獲取所有乘客的資訊
  const [result] = await executeSQL(
    `SELECT line_user_id, line_user_name FROM users WHERE line_user_type = '乘客' AND line_user_driver = ?`,
    [profile.userId]
  );

  // 2. 檢查查詢結果
  if (result.length === 0) {
    createResponse('text', `目前尚無乘客資訊。`);
  } else {
    let responseText = '目前的乘客資訊為(請複製對應 ID 將乘客綁定)：\n';
    result.forEach((entry) => {
      responseText += `${entry.line_user_name} : ${entry.line_user_id}\n`;
    });
    createResponse('text', responseText);
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
    // 此區塊處理已存在的用戶
    const userLineType = validationResult.user.line_user_type;
    const command =
      COMMANDS_MAP[userLineType] &&
      COMMANDS_MAP[userLineType][event.message.text];
    const userFunction = command ? command.function : null;
    const fareTransferMatch = event.message.text.includes('車費匯款');
    // 是否為乘客判斷有無綁定司機ID
    const [userData] = await executeSQL(
      'SELECT line_user_driver FROM users WHERE line_user_id = ?',
      [profile.userId]
    );
    if (userData.length === 0 && userLineType === '乘客') {
      const [result] = await executeSQL(
        `SELECT line_user_id, line_user_name FROM users WHERE line_user_type = '司機'`
      );
      let responseText = '';
      result.forEach((entry) => {
        responseText += `${entry.line_user_name} : ${entry.line_user_id}\n`;
      });
      createResponse(
        'text',
        `${profile.displayName} 您尚未綁定司機 ID。注意請先完成綁定搭乘司機後方可計算日後車費，目前司機名單為:\n${responseText}\n 請輸入以下指令，(輸入範例: 綁定搭乘司機:此位置複製上方搭乘司機對應的ID碼)`
      );
      // use reply API
      return client.replyMessage(event.replyToken, echo);
    }
    // ==========================================================
    if (userFunction) {
      await userFunction(profile, event); // 正確指令執行對應的功能
    } else if (fareTransferMatch && userLineType === '乘客') {
      await fareTransfer(profile, event); // 車費匯款特別處理
    } else {
      if (userLineType) {
        if (event.message.text === '指令') {
          const commandsString = getCommandsAsString(userLineType);
          createResponse(
            'text',
            `${userLineType} ${profile.displayName} 歡迎回來，${commandsString}`
          );
        } else {
          // 組合整體訊息
          createResponse(
            'text',
            `${userLineType} ${profile.displayName} 歡迎回來，請輸入"指令"了解指令用法。`
          );
        }
      } else {
        createResponse('text', '檢測資料異常，請聯絡開發人員!');
      }
    }
  } else if (validationResult.type === 'create_user') {
    // 此區塊處理新用戶
    userType = event.message.text === '我是乘客' ? '乘客' : '司機';
    await handleUserTypeChange(profile, userType);
    if (userType === '乘客') {
      const [result] = await executeSQL(
        `SELECT line_user_id, line_user_name FROM users WHERE line_user_type = '司機'`
      );
      let responseText = '';
      result.forEach((entry) => {
        responseText += `${entry.line_user_name} : ${entry.line_user_id}\n`;
      });
      createResponse(
        'text',
        `${profile.displayName} ，我已經將您切換為 ${userType} ，注意請先完成下一步綁定搭乘司機\n${responseText}\n 輸入範例: (綁定搭乘司機:此位置複製上方搭乘司機對應的ID碼)`
      );
    } else {
      createResponse(
        'text',
        `${profile.displayName} ，我已經將您切換為 ${userType} !`
      );
    }
  } else if (validationResult.type === 'repeat_command') {
    // 此區塊處理重複指令
    createResponse('text', '如需切換使用者請聯絡開發人員');
  } else if (validationResult.type === 'super_user') {
    // 此區塊處理技術支援
    createResponse(
      'text',
      '嗨! 我是開發者 77 這是我的 LINE ID: 0925955648，如果你真的需要我的幫助，請再聯繫我 !'
    );
  } else {
    // 此區塊處理未依規則指令
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
