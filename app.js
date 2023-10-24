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
      remark: '先行匯款後輸入之金額紀錄 (輸入範例> 車費匯款:1200)',
    },
    車費查詢: {
      function: fareSearch,
      remark:
        '確認加減原匯款金額之剩餘費用，例如:未搭車或多搭乘 (輸入範例> 車費查詢)',
    },
    綁定司機: {
      function: bindDriverId,
      remark: '綁定司機後方可計算日後車費 (輸入範例> 綁定司機:司機ID)',
    },
    // 可以根據需求繼續新增功能
  },
  司機: {
    車費計算表: {
      function: fareIncome,
      remark: '取得"目前乘客名稱與所得費用" (輸入範例> 車費計算表)',
    },
    乘客資訊: {
      function: passengerInfo,
      remark:
        '取得"目前乘客名稱與更改資訊ID，ID為需要修改資訊時才會使用到" (輸入範例> 乘客資訊)',
    },
    乘客車資計算: {
      function: passengerFareCount,
      remark:
        '先輸入乘客資訊後取得目前乘客名稱與更改資訊ID，複製對應ID為乘客加減車資紀錄。複製範例修改>\n Ue3fb7c1:+100 備註:Josh多搭車\nPS:備註限30字內，建議加入乘客名，增加辨識',
    },
    車資收入: {
    	function: totalFareCount,
    	remark: '取得名下所有乘客收取費用加總 (輸入範例> 車資收入)',
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

// 共用-回傳訊息格式
function createResponse(type, message) {
  echo = {type: type, text: message};
}

// 共用-指令格式
function getCommandsAsString(userType) {
  const commands = Object.entries(COMMANDS_MAP[userType]).map(
    ([key, value]) => `\n > ${key}: ${value.remark}`
  );
  return `指令為:\n ${commands.join('。\n')}。`;
}

// 共用-儲存SQL日期格式
function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0'); //January is 0!
  const yyyy = date.getFullYear();

  return `${yyyy}-${mm}-${dd}`;
}

// 共用-日期格式
function formatDateToChinese(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // getMonth() 返回的月份從0開始，所以要+1
  const day = date.getDate();
  return `${year}年${month}月${day}日`;
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
    'SELECT user_fare, update_time FROM fare WHERE line_user_id = ? ORDER BY ABS(DATEDIFF(update_time, CURDATE())) ASC LIMIT 1',
    [profile.userId]
  );
  const fareDetails = await executeSQL(
    'SELECT user_fare_count, user_remark, update_time FROM fare_count WHERE line_user_id = ? AND MONTH(update_time) = MONTH(CURDATE()) AND YEAR(update_time) = YEAR(CURDATE()) ORDER BY update_time ASC', // 修改了這裡的排序
    [profile.userId]
  );
  const fare = userFare[0].user_fare;

  if (userFare.length === 0) {
    createResponse('text', `${profile.displayName}，您尚未有車費紀錄。`);
  } else if (fareDetails[0].length === 0) {
    const updateTime = new Date(userFare[0].update_time);
    const formattedDate = formatDateToChinese(updateTime);
    createResponse(
      'text',
      `${profile.displayName} ，您最近的車費及時間為 NT$${fare} ${formattedDate}。`
    );
  } else {
    let message = `${profile.displayName}，您本月的車費細項如下:\n`;
    let totalFare = fare; // 原始車費

    for (const fareDetail of fareDetails[0]) {
      const date = formatDateToChinese(new Date(fareDetail.update_time));
      totalFare += fareDetail.user_fare_count;
      message += `\n> ${date} 原車費NT$${totalFare - fareDetail.user_fare_count}${
        fareDetail.user_fare_count >= 0 ? '+' : ''
      }${fareDetail.user_fare_count} = 剩餘NT$${totalFare} ， 原因為: ${
        fareDetail.user_remark || '無'
      }\n`; // 進一步調整了這裡的格式
    }

    createResponse('text', message);
  }
}

// 乘客-綁定司機的操作
async function bindDriverId(profile, event) {
  // 1. 擷取輸入的司機ID
  const driverMatch = event.message.text.match(/^綁定司機\s*[:：]?\s*(.*)$/);
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
      `${profile.displayName} ，請輸入正確格式，範例: "綁定司機:Ue3fb7c1..."。`
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
async function passengerInfo(profile) {
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

// 司機-紀錄乘客車資
async function passengerFareCount(profile, event) {
  const inputMatch = event.message.text.match(
    /^([a-zA-Z0-9]+)\s*:? ?([+-]\d+)\s*備註:? ?(.+)/
  );

  if (!inputMatch) {
    createResponse(
      'text',
      `${profile.displayName} ，請輸入正確格式，範例: "Ue3fb7c1...:+100 備註:Josh，10/10多搭車"。`
    );
    return;
  }

  const userId = inputMatch[1];
  const fareChange = parseInt(inputMatch[2], 10);

  const remark = inputMatch[3];

  // 查詢line_user_driver是否符合profile.userID
  const driverData = await executeSQL(
    'SELECT * FROM users WHERE line_user_driver = ?',
    [profile.userId]
  );
  if (!driverData || driverData.length === 0) {
    createResponse('text', `${profile.displayName} ，無效的司機ID。`);
    return;
  }

  // 檢查line_user_id是否存在於剛查詢的driverData表中
  const actualDriverData = driverData[0];
  const userData = actualDriverData.find(
    (data) => data.line_user_id === userId
  ); // 對應乘客資訊
  const passengerName = userData.line_user_name; // 乘客姓名
  const currentDate = new Date();

  if (!userData) {
    createResponse('text', `${profile.displayName} ，請輸入正確的用戶 ID。`);
    return;
  }
  // // 從fare表取出對應用戶ID的user_fare並進行計算
  // const [fareData] = await executeSQL('SELECT user_fare FROM fare WHERE line_user_id = ?', [userId]);
  // let newFare = 0;
  //
  // if (fareData && fareData.length > 0) {
  // 	newFare = fareData[0].user_fare + fareChange;
  // } else {
  // 	createResponse('text', `${profile.displayName} ，目前用戶尚無匯款費用可供計算。`);
  // 	return;
  // }

  // 儲存到fare_count表
  await executeSQL(
    'INSERT INTO fare_count (line_user_id, user_fare_count, user_remark, update_time) VALUES (?, ?, ?, ?)',
    [userId, fareChange, remark, formatDate(currentDate)]
  );

  createResponse(
    'text',
    `${formatDateToChinese(
      currentDate
    )} 乘客:${passengerName} ，車費資料 ${fareChange} 已成功紀錄!`
  );
}

// 司機-取得乘客匯款收入
async function totalFareCount(profile) {
  // 1. 從 users 表找到 line_user_driver 所有符合 profile.userId 的資料
  const passengers = await executeSQL(
      'SELECT line_user_id, line_user_name FROM users WHERE line_user_driver = ?',
      [profile.userId]
  );

  // 檢查是否有資料
  if (passengers[0].length === 0) {
    createResponse(
        'text',
        `${profile.displayName} ，目前名下無其他乘客。`
    );
    return;
  }

  // 存儲每個乘客的車費細節
  const passengerDetails = [];

  let totalIncome = 0; // 總共收入

  for (const passenger of passengers[0]) {
    // 2. 根據 line_user_id 去 fare 表格中找對應當月的資料
    const fares = await executeSQL(
        'SELECT user_fare, update_time FROM fare WHERE line_user_id = ? AND MONTH(update_time) = MONTH(CURDATE()) AND YEAR(update_time) = YEAR(CURDATE())',
        [passenger.line_user_id]
    );

    let fareAmount = 0; // 乘客的車費

    // 檢查是否有資料
    if (fares[0].length > 0) {
      fareAmount = fares[0].user_fare;
      totalIncome += fareAmount;
    }

    // 3. 根據 line_user_id 去 fare_count 表格中找對應的資料
    const fareCounts = await executeSQL(
        'SELECT user_fare_count FROM fare_count WHERE line_user_id = ? AND MONTH(update_time) = MONTH(CURDATE()) AND YEAR(update_time) = YEAR(CURDATE())',
        [passenger.line_user_id]
    );
    console.log("測試fares", fareCounts)
    let fareCountAmount = 0; // 乘客的 fare_count 總和
    for (const fareCount of fareCounts[0]) {
      fareCountAmount += fareCount.user_fare_count;
    }

    if (fares.length === 0 && fareCounts.length === 0) {
      passengerDetails.push({
        name: passenger.line_user_name,
        noRecord: true
      });
    } else {
      passengerDetails.push({
        name: passenger.line_user_name,
        totalFare: fareAmount + fareCountAmount,
        fareCount: fareCountAmount
      });
    }
  }

  // 根據乘客的車費細節生成回應消息
  let message = `10月份車資\n\n`;

  for (const detail of passengerDetails) {
    if (detail.noRecord) {
      message += `乘客: ${detail.name} 此月份尚無匯款紀錄\n`;
    } else {
      message += `乘客: ${detail.name} 車資為: ${detail.totalFare}`;
      if (detail.fareCount > 0) {
        message += ` 餘${detail.fareCount}`;
      } else if (detail.fareCount < 0) {
        message += ` 欠${Math.abs(detail.fareCount)}`;
      }
      message += `\n`;
    }
  }

  message += `總共收入: ${totalIncome}`;

  createResponse('text', message);
}

// 主要處理指令函式
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
    const inputText = event.message.text.trim(); // 移除前後的空白
    const command =
      COMMANDS_MAP[userLineType] && COMMANDS_MAP[userLineType][inputText];
    const userFunction = command ? command.function : null;
    const fareTransferMatch = event.message.text.includes('車費匯款'); // 乘客
    const bindDriverMatch = event.message.text.includes('綁定司機'); // 乘客
    const FareCountCommandsMatch = event.message.text.match(
      /^([a-zA-Z0-9]+)\s*:? ?([+-]\d+)\s*備註:? ?(.+)/
    );

    // 是否為乘客判斷有無綁定司機ID
    const [userData] = await executeSQL(
      'SELECT line_user_driver FROM users WHERE line_user_id = ?',
      [profile.userId]
    );

    if (
      !userData[0].line_user_driver &&
      userLineType === '乘客' &&
      !bindDriverMatch
    ) {
      const [result] = await executeSQL(
        `SELECT line_user_id, line_user_name FROM users WHERE line_user_type = '司機'`
      );
      let responseText = '';
      result.forEach((entry) => {
        responseText += `\n司機名稱: ${entry.line_user_name} ，複製此ID: ${entry.line_user_id}\n`;
      });
      createResponse(
        'text',
        `${profile.displayName} 您尚未綁定司機 ID。注意請先完成綁定司機後方可計算日後車費，目前司機名單為:\n${responseText}\n 請輸入以下指令，(輸入範例: 綁定司機:U276d4...)`
      );
      // use reply API
      return client.replyMessage(event.replyToken, echo);
    }
    // ==========================================================
    if (userFunction) {
      await userFunction(profile, event); // 正確指令執行對應的功能
    } else if ((fareTransferMatch || bindDriverMatch) && userLineType === '乘客')
    {
      if (fareTransferMatch) {
        await fareTransfer(profile, event); // 車費匯款特別處理
      }
      if (bindDriverMatch) {
        await bindDriverId(profile, event); // 綁定司機 ID 特別處理
      }
    } else if (FareCountCommandsMatch && userLineType === '司機') {
      if (FareCountCommandsMatch) {
        await passengerFareCount(profile, event); // 車費匯款特別處理
      }
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
        `${profile.displayName} ，我已經將您切換為 ${userType} ，注意請先完成下一步綁定司機\n${responseText}\n 輸入範例: (綁定司機:此位置複製上方搭乘司機對應的ID碼)`
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
