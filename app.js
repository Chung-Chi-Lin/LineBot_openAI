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

pool.connect()
		.then(() => {
			console.log('Connected to the database.');
		})
		.catch(err => {
			console.error('Database connection error:', err);
		});
// create LINE SDK client
const client = new line.Client(config);

// ==================================================== create Express app ====================================================
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
					text: '資料處理重啟中，請稍等2分鐘後重試',
				};
				return client
						.replyMessage(req.body.events[0].replyToken, errorMessage)
						.then(() => {
							res.status(500).end();
						});
			});
});

// ==================================================== 主要事件處理處 ====================================================
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
		司機預約表: {
			function: pickDriverReverse,
			remark: '點選網址連結 Google 預約乘車時間，請於上方查看司機規定之預約方式 (輸入範例> 司機預約表)',
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
					'先輸入乘客資訊後取得目前乘客名稱與更改資訊ID，複製對應ID為乘客加減車資紀錄。\n複製範例修改>\n Ue3fb7c1:+100 備註:Josh多搭車\nPS:備註限30字內，建議加入乘客名，增加辨識',
		},
		車資收入: {
			function: totalFareCount,
			remark: '取得名下所有乘客收取費用加總 (輸入範例> 車資收入)',
		},
		預約日設定: {
			function: openDriverReverse,
			remark: '查看先前預約以及設置開放預約乘客時間，乘客端可以搜尋到您開放的日期，請務必輸入區間及備註，如僅有一天區間都設定同日期。\n(複製範例1> 預約日設定: 2023-10-03~2023-10-28:開車 備註:不含國定假日 乘客數量:3)\n(複製範例2> 預約日設定: 2023-10-10~2023-10-15:不開車 備註:出國)',
		},
		// 可以根據需求繼續新增功能
	},
};
let echo = {}; // Bot 回傳提示字

// ==================================================== 共用函式 ====================================================
// 驗證用戶是否存在於資料庫
async function validateUser(profile, event) {
	// 是否有 ID 在資料庫
	const [existingUsers] = await executeSQL(
			'SELECT * FROM users WHERE line_user_id = @line_user_id',
			{ line_user_id: profile.userId }
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

// ==================================================== SQL函式處 ====================================================
// SQL 專用 function
async function executeSQL(query, params) {
	try {
		const request = pool.request();

		for (const param in params) {
			const value = params[param];
			let detectedType;

			if (typeof value === 'string') {
				detectedType = sql.NVarChar;
			} else if (typeof value === 'number') {
				detectedType = sql.Int;
			} else if (value instanceof Date) {
				detectedType = sql.DateTime;
			} else {
				detectedType = sql.VarBinary; // 假設其他非指定類型都是VarBinary
			}

			request.input(param, detectedType, value);
		}

		const result = await request.query(query);
		return [result.recordset, result.columns];

	} catch (error) {
		createResponse('text', '資料異常請聯絡開發人員');
		console.error('SQL Error:', error);
		throw error;
	}
}

// 新建用戶
async function handleUserTypeChange(profile, userType) {
	await executeSQL(
			'INSERT INTO users (line_user_id, line_user_name, line_user_type) VALUES (@p1, @p2, @p3)',
			{p1: profile.userId, p2: profile.displayName, p3: userType}
	);
}

// ==================================================== 對應指令功能 ====================================================
// ============= 乘客對應函式 =============
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
			'SELECT user_fare, update_time FROM fare WHERE line_user_id = @p1 AND update_time = (SELECT TOP 1 update_time FROM fare WHERE line_user_id = @p2 ORDER BY ABS(DATEDIFF(DAY, update_time, GETDATE())))',
			{p1: profile.userId, p2: profile.userId}
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
			'INSERT INTO fare (line_user_id, user_fare, update_time) VALUES (@p1, @p2, @p3)',
			{p1: profile.userId, p2: fareAmount, p3: formatDate(currentDate)}
	);

	return createResponse(
			'text',
			`${profile.displayName} ，您的車費 NT$${fareAmount} 已被記錄。`
	);
}

// 乘客-車費查詢的操作
async function fareSearch(profile) {
	const [userFare] = await executeSQL(
			'SELECT TOP 1 user_fare, update_time FROM fare WHERE line_user_id = @p1 ORDER BY ABS(DATEDIFF(DAY, update_time, GETDATE()))',
			{p1: profile.userId}
	);
	const fareDetails = await executeSQL(
			'SELECT user_fare_count, user_remark, update_time FROM fare_count WHERE line_user_id = @p1 AND MONTH(update_time) = MONTH(GETDATE()) AND YEAR(update_time) = YEAR(GETDATE()) ORDER BY update_time ASC',
			{p1: profile.userId}
	);

	if (userFare.length === 0) {
		createResponse('text', `${profile.displayName}，您尚未有車費紀錄。`);
		return;
	}

	const fare = userFare[0].user_fare;
	const updateTime = new Date(userFare[0].update_time);
	const formattedDate = formatDateToChinese(updateTime);

	if (fareDetails[0].length === 0) {
		createResponse(
				'text',
				`${profile.displayName} ，您最近的車費及時間為 NT$${fare} ${formattedDate}。`
		);
	} else {
		let total = 0;
		let message = `${profile.displayName}，您目前的車費細項如下:\n上次匯款車費及時間: NT$${fare} ${formattedDate}\n`;

		for (const fareDetail of fareDetails[0]) {
			const date = formatDateToChinese(new Date(fareDetail.update_time));
			total += fareDetail.user_fare_count;
			message += `\n> 紀錄時間${date} ${fareDetail.user_fare_count >= 0 ? '+' : ''}${fareDetail.user_fare_count} ， 原因為: ${fareDetail.user_remark || '無'}\n`;
		}
		message += `\n 計算後下月${total <= 0 ? '扣除' : '需補'} ${Math.abs(total)}`;
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
				`SELECT line_user_id FROM users WHERE line_user_id = @p1 AND line_user_type = N'司機'`,
				{p1: driverId}
	);

		if (driverData.length === 0) {
			createResponse(
					'text',
					`${profile.displayName} ，您輸入錯誤司機ID 請於上方訊息查看司機ID。`
			);
		} else {
			// 3. 更新使用者的 line_user_driver 欄位
			await executeSQL(
					'UPDATE users SET line_user_driver = @p1 WHERE line_user_id = @p2',
					{p1: driverId, p2: profile.userId}
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

// 乘客-預約司機乘車的操作
async function pickDriverReverse(profile) {
	// 1. 從 users 表找到 line_user_driver 所有符合 profile.userId 的資料
	const passengers = await executeSQL(
			'SELECT line_user_id, line_user_name FROM users WHERE line_user_driver = @p1',
			{p1: profile.userId}
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
				'SELECT user_fare, update_time FROM fare WHERE line_user_id = @p1 AND MONTH(update_time) = MONTH(GETDATE()) AND YEAR(update_time) = YEAR(GETDATE())',
				{p1: passenger.line_user_id}
		);

		let fareAmount = 0; // 乘客的車費

		// 檢查是否有資料
		if (fares[0].length > 0) {
			fareAmount = fares[0][0].user_fare;
			totalIncome += fareAmount;
		}

		// 3. 根據 line_user_id 去 fare_count 表格中找對應的資料
		const fareCounts = await executeSQL(
				'SELECT user_fare_count FROM fare_count WHERE line_user_id = @p1 AND MONTH(update_time) = MONTH(GETDATE()) AND YEAR(update_time) = YEAR(GETDATE())',
				{p1: passenger.line_user_id}
		);

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
				totalFare: fareAmount,
				fareCount: fareCountAmount
			});
		}
	}

	// 根據乘客的車費細節生成回應消息
	let message = `10月份車資\n\n`;

	for (const detail of passengerDetails) {
		if (detail.noRecord) {
			message += `乘客: ${detail.name}，此月份尚無匯款紀錄\n`;
		} else {
			message += `乘客: ${detail.name}，匯款車資為: ${detail.totalFare}`;
			if (detail.fareCount > 0) {
				message += `，下月需多收NT$${detail.fareCount}`;
			} else if (detail.fareCount < 0) {
				message += `，下月車資扣除NT$${Math.abs(detail.fareCount)}`;
			}
			message += `\n`;
		}
	}

	message += `<總共收入: NT$${totalIncome}>`;

	createResponse('text', message);
}
// ============= 司機對應函式 =============
// 司機-顯示司機的乘客車費計算表
async function fareIncome(profile) {
	// 1. 執行SQL查詢來獲取特定司機的所有乘客的車費紀錄
	const [result] = await executeSQL(
			`SELECT u.line_user_name, f.user_fare, FORMAT(f.update_time, 'yyyy-MM-dd') AS formatted_date
        FROM fare AS f
        JOIN users AS u ON f.line_user_id = u.line_user_id
        WHERE u.line_user_driver = @p1`,
			{p1: profile.userId}
	);

	// 2. 檢查查詢結果
	if (result.length === 0) {
		createResponse('text', `目前尚無車費紀錄。`);
	} else {
		let responseText = '目前的車費計算表為：\n';
		result.forEach((entry) => {
			responseText += `\n${entry.line_user_name} : NT$${entry.user_fare}，匯款時間為 ${entry.formatted_date}\n`;
		});
		createResponse('text', responseText);
	}
}

// 司機-顯示乘客資訊
async function passengerInfo(profile) {
	// 1. 執行SQL查詢來獲取所有乘客的資訊
	const [result] = await executeSQL(
			`SELECT line_user_id, line_user_name FROM users WHERE line_user_type = N'乘客' AND line_user_driver = @p1`,
			{p1: profile.userId}
	);

	// 2. 檢查查詢結果
	if (result.length === 0) {
		createResponse('text', `目前尚無乘客資訊。`);
	} else {
		let responseText = '目前的乘客資訊為(請複製對應 ID 將乘客綁定)：\n';
		result.forEach((entry) => {
			responseText += `\n${entry.line_user_name} : ${entry.line_user_id}\n`;
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
			'SELECT * FROM users WHERE line_user_driver = @p1',
			{p1: profile.userId}
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
	// 儲存到fare_count表
	await executeSQL(
			'INSERT INTO fare_count (line_user_id, user_fare_count, user_remark, update_time) VALUES (@p1, @p2, @p3, @p4)',
			{p1: userId, p2: fareChange, p3: remark, p4: formatDate(currentDate)}
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
			'SELECT line_user_id, line_user_name FROM users WHERE line_user_driver = @p1',
			{p1: profile.userId}
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
				'SELECT user_fare, update_time FROM fare WHERE line_user_id = @p1 AND MONTH(update_time) = MONTH(GETDATE()) AND YEAR(update_time) = YEAR(GETDATE())',
				{p1: passenger.line_user_id}
		);

		let fareAmount = 0; // 乘客的車費

		// 檢查是否有資料
		if (fares[0].length > 0) {
			fareAmount = fares[0][0].user_fare;
			totalIncome += fareAmount;
		}

		// 3. 根據 line_user_id 去 fare_count 表格中找對應的資料
		const fareCounts = await executeSQL(
				'SELECT user_fare_count FROM fare_count WHERE line_user_id = @p1 AND MONTH(update_time) = MONTH(GETDATE()) AND YEAR(update_time) = YEAR(GETDATE())',
				{p1: passenger.line_user_id}
		);

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
				totalFare: fareAmount,
				fareCount: fareCountAmount
			});
		}
	}

	// 根據乘客的車費細節生成回應消息
	let message = `10月份車資\n\n`;

	for (const detail of passengerDetails) {
		if (detail.noRecord) {
			message += `乘客: ${detail.name}，此月份尚無匯款紀錄\n`;
		} else {
			message += `乘客: ${detail.name}，匯款車資為: ${detail.totalFare}`;
			if (detail.fareCount > 0) {
				message += `，下月需多收NT$${detail.fareCount}`;
			} else if (detail.fareCount < 0) {
				message += `，下月車資扣除NT$${Math.abs(detail.fareCount)}`;
			}
			message += `\n`;
		}
	}

	message += `<總共收入: NT$${totalIncome}>`;

	createResponse('text', message);
}

// 司機-開放預約時間
async function openDriverReverse(profile, event) {
	// 0. 解析司機輸入的訊息
	// 修改正則表達式使乘客數量可選
	const inputPattern = /預約日設定:(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2}):(開車|不開車) 備註:([^乘客數量:]*)\s?(?:乘客數量:(\d+))?/;
	const inputMatch = event.message.text.match(inputPattern);

	if (!inputMatch) {
		createResponse('text', `${profile.displayName} ，輸入格式不正確。`);
		return;
	}

	const startDate = inputMatch[1];
	const endDate = inputMatch[2];
	const reverseType = inputMatch[3];
	const note = inputMatch[4];
	// 如果 reverseType 為開車且相應的數量匹配存在，則解析乘客數量；如果不開車，則乘客數量為 null
	const limit = reverseType === '開車' && inputMatch[5] ? parseInt(inputMatch[5], 10) : null;

	// 1. 驗證日期是否合法，並且不是過去的時間
	const currentDateTime = new Date();
	const startDateTime = new Date(startDate);
	const endDateTime = new Date(endDate);

	if (startDateTime < currentDateTime || endDateTime < currentDateTime) {
		createResponse('text', `${profile.displayName} ，請設置今天後的日期。`);
		return;
	}

	// 2. 驗證是否在同一個月份
	if (startDateTime.getMonth() !== endDateTime.getMonth() || startDateTime.getFullYear() !== endDateTime.getFullYear()) {
		createResponse('text', `${profile.displayName} ，請輸入同月份時間範圍。`);
		return;
	}

	// 若是開車，但沒有提供乘客數量，則返回錯誤
	if (reverseType === '開車' && limit === null) {
		createResponse('text', `${profile.displayName} ，請提供乘客數量。`);
		return;
	}
	// 檢查資料庫中是否存在符合 profile.userId 且是當月的記錄
	const existingRecord = await executeSQL(
			'SELECT * FROM driver_dates WHERE line_user_driver = @userId AND MONTH(start_date) = @currentMonth AND YEAR(start_date) = @currentYear',
			{ userId: profile.userId, currentMonth: startDateTime.getMonth() + 1, currentYear: startDateTime.getFullYear() }
	);

	if (!existingRecord || existingRecord.length === 0) {
		const reverseTypeValue = reverseType === '開車' ? 1 : 0;
		await executeSQL(
				'INSERT INTO driver_dates (line_user_driver, start_date, end_date, reverse_type, note, limit) VALUES (@userId, @startDate, @endDate, @reverseType, @note, @limit)',
				{ userId: profile.userId, startDate: startDate, endDate: endDate, reverseType: reverseTypeValue, note: note, limit: limit }
		);
		createResponse('text', `${profile.displayName} ，已設定好預約表。`);
	} else {
		// 3. 根據 reverseType 確定是否可以覆蓋或添加數據
		// 如果是 '開車' 狀態，更新資料庫記錄，包括 limit
		if (reverseType === '開車') {
			await executeSQL(
					'UPDATE driver_dates SET start_date = @startDate, end_date = @endDate, reverse_type = @reverseType, note = @note, limit = @limit WHERE line_user_driver = @userId',
					{ startDate: startDate, endDate: endDate, reverseType: 1, note: note, limit: limit, userId: profile.userId }
			);
			createResponse('text', `${profile.displayName} ，已覆蓋原月份預約時間。`);
		} else {
			// 插入新的預約到資料庫，不包含 limit
			await executeSQL(
					'INSERT INTO driver_dates (line_user_driver, start_date, end_date, reverse_type, note) VALUES (@userId, @startDate, @endDate, @reverseType, @note)',
					{ userId: profile.userId, startDate: startDate, endDate: endDate, reverseType: 0, note: note }
			);
			createResponse('text', `${profile.displayName} ，已設定好預約表。`);
		}
	}
};

// ==================================================== 主要處理指令函式 ====================================================
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
		);// 司機
		const isdriverReverse = event.message.text.includes('預約日設定'); // 司機

		// 是否為乘客判斷有無綁定司機ID
		const [userData] = await executeSQL(
				'SELECT line_user_driver FROM users WHERE line_user_id = @p1',
				{p1: profile.userId}
		);

		if (
				!userData[0].line_user_driver &&
				userLineType === '乘客' &&
				!bindDriverMatch
		) {
			const [result] = await executeSQL(
					`SELECT line_user_id, line_user_name FROM users WHERE line_user_type = N'司機'`
			);
			let responseText = '';
			result.forEach((entry) => {
				responseText += `\n司機名稱: ${entry.line_user_name}>複製此ID: ${entry.line_user_id}。\n`;
			});
			createResponse(
					'text',
					`${profile.displayName} 您尚未綁定司機 ID。注意請先完成綁定司機後方可計算日後車費，目前司機名單為:\n${responseText ? responseText : "*目前無司機*"}\n 請輸入以下指令，(輸入範例: 綁定司機:U276d4...)`
			);
			// use reply API
			return client.replyMessage(event.replyToken, echo);
		}

		if (userFunction) {
			await userFunction(profile, event); // 正確指令執行對應的功能
		} else if ((fareTransferMatch || bindDriverMatch) && userLineType === '乘客') {
			if (fareTransferMatch) {
				await fareTransfer(profile, event); // 車費匯款特別處理
			}
			if (bindDriverMatch) {
				await bindDriverId(profile, event); // 綁定司機 ID 特別處理
			}
		} else if ((FareCountCommandsMatch || isdriverReverse) && userLineType === '司機') {
			if (FareCountCommandsMatch) {
				await passengerFareCount(profile, event); // 車費匯款特別處理
			}
			if (isdriverReverse){
				await openDriverReverse(profile, event); // 預約日設定
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
					`SELECT line_user_id, line_user_name FROM users WHERE line_user_type = N'司機'`
			);
			let responseText = '';
			result.forEach((entry) => {
				responseText += `${entry.line_user_name} : ${entry.line_user_id}\n`;
			});
			createResponse(
					'text',
					`${profile.displayName} ，我已經將您切換為 ${userType} ，注意請先完成下一步綁定司機\n${responseText ? responseText : "*目前無司機*"}\n 輸入範例: (綁定司機:此位置複製上方搭乘司機對應的ID碼)`
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

// ========================== listen on port ==========================
const port = process.env.PORT || 3000;
// 預設的錯誤處理器
app.use((err, req, res, next) => {
	console.error(err.stack);
	res.status(500).send('伺服器忙碌中，請稍後重試');
});
app.listen(port, () => {
	console.log(`listening on ${port}`);
});
