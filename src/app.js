/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");

// 只配置一个 recording appender
log4js.configure({
  appenders: {
    vcr: { type: "recording" }
  },
  categories: { 
    default: { 
      appenders: ["vcr"], 
      level: "info" 
    } 
  },
});

const logger = log4js.getLogger();
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
  } else {
    result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const doTask = async (cloudClient) => {
  const result = [];
  const res1 = await cloudClient.userSign();
  result.push(
    `${res1.isSign ? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`
  );
  await delay(5000);

  const res2 = await cloudClient.taskSign();
  buildTaskResult(res2, result);

  await delay(5000);
  const res3 = await cloudClient.taskPhoto();
  buildTaskResult(res3, result);

  return result;
};

const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  const result = [];
  let totalBonusSpace = 0;
  const targetFamilyId = '108981821788983';
  
  if (familyInfoResp) {
    for (let index = 0; index < familyInfoResp.length; index += 1) {
      const res = await cloudClient.familyUserSign(targetFamilyId);
      const bonusSpace = Number(res.bonusSpace) || 0;
      totalBonusSpace += bonusSpace;
      
      if (bonusSpace > 0) {
        result.push(`家庭任务签到获得${bonusSpace}M空间`);
      }
    }
  }

  return { 
    result, 
    totalBonusSpace,
    summary: totalBonusSpace > 0 ? `共获得${totalBonusSpace}M空间` : '未获得新的空间'
  };
};

// 推送相关函数保持不变...
const pushServerChan = (title, desp) => {
  if (!serverChan.sendKey) return;
  const data = { title, desp };
  
  superagent
    .post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .type("form")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`ServerChan推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.code !== 0) {
        logger.error(`ServerChan推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("ServerChan推送成功");
      }
    });
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBot.botToken && telegramBot.chatId)) return;
  
  const data = {
    chat_id: telegramBot.chatId,
    text: `${title}\n\n${desp}`,
  };
  
  superagent
    .post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
    .type("form")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (!json.ok) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("TelegramBot推送成功");
      }
    });
};

const pushWecomBot = (title, desp) => {
  if (!(wecomBot.key && wecomBot.telphone)) return;
  
  const data = {
    msgtype: "text",
    text: {
      content: `${title}\n\n${desp}`,
      mentioned_mobile_list: [wecomBot.telphone],
    },
  };
  
  superagent
    .post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`wecomBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.errcode) {
        logger.error(`wecomBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wecomBot推送成功");
      }
    });
};

const pushWxPusher = (title, desp) => {
  if (!(wxpush.appToken && wxpush.uid)) return;
  
  const data = {
    appToken: wxpush.appToken,
    contentType: 1,
    summary: title,
    content: desp,
    uids: [wxpush.uid],
  };
  
  superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`wxPusher推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.data[0].code !== 1000) {
        logger.error(`wxPusher推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wxPusher推送成功");
      }
    });
};

const push = (title, desp) => {
  pushServerChan(title, desp);
  pushTelegramBot(title, desp);
  pushWecomBot(title, desp);
  pushWxPusher(title, desp);
};

// 主函数优化
async function main() {
  let totalBonusSpaceAllAccounts = 0;
  const maxConcurrency = 5;
  const tasksQueue = [...accounts];

  while (tasksQueue.length > 0) {
    const currentTasks = tasksQueue.splice(0, maxConcurrency);

    await Promise.all(currentTasks.map(async account => {
      const { userName, password } = account;
      if (userName && password) {
        const userNameInfo = mask(userName, 3, 7);
        try {
          logger.info(`账户 ${userNameInfo} 开始执行`);
          const cloudClient = new CloudClient(userName, password);
          await cloudClient.login();
          
          // 执行常规任务
          const result = await doTask(cloudClient);
          result.forEach(r => logger.info(r));
          
          // 执行家庭任务
          const { result: familyResult, totalBonusSpace, summary } = await doFamilyTask(cloudClient);
          familyResult.forEach(r => logger.info(r));
          if (totalBonusSpace > 0) {
            logger.info(summary);
          }
          
          totalBonusSpaceAllAccounts += totalBonusSpace;

          // 获取容量信息
          const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
          logger.info(
            `个人总容量：${(cloudCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2)}G,` +
            `家庭总容量：${(familyCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2)}G`
          );
          
        } catch (e) {
          logger.error(`账户 ${userNameInfo} 执行出错: ${e.message}`);
          if (e.code === "ETIMEDOUT") {
            throw e;
          }
        } finally {
          logger.info(`账户 ${userNameInfo} 执行完毕\n`);
        }
      }
    }));
  }

  logger.info(`所有账号共获得空间：${totalBonusSpaceAllAccounts}M`);
}

// 程序入口
(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    const content = events
      .map(e => e.data.join(""))
      .join("\n");
    push("天翼云盘自动签到任务", content);
    recording.erase();
  }
})();
