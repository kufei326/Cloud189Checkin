/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: { type: "console" },
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } },
});

const logger = log4js.getLogger();
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");
const pLimit = require("p-limit");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 构建抽奖任务结果
const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败, 次数不足`);
  } else {
    result.push(`第${index}次抽奖成功, 获得${res.prizeName}`);
  }
};

// 任务 1.签到 2.天天抽红包 3.自动备份抽红包
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

// 家庭签到任务
const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  let totalBonusSpace = 0;
  const result = [];
  if (familyInfoResp) {
    for (const family of familyInfoResp) {
      const { familyId } = family;
      const res = await cloudClient.familyUserSign(familyId);
      result.push(
        `家庭任务${res.signStatus ? "已经签到过了，" : ""}签到获得${res.bonusSpace}M空间`
      );
      // 只统计 res.bonusSpace
      totalBonusSpace += res.bonusSpace || 0;
    }
  }
  return { result, totalBonusSpace };
};

// 推送通知
const pushNotification = (title, desp) => {
  if (serverChan.sendKey) {
    const data = { title, desp };
    superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`).type("form").send(data);
  }
  if (telegramBot.botToken && telegramBot.chatId) {
    const data = { chat_id: telegramBot.chatId, text: `${title}\n\n${desp}` };
    superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`).type("form").send(data);
  }
  if (wecomBot.key && wecomBot.telphone) {
    const data = {
      msgtype: "text",
      text: { content: `${title}\n\n${desp}`, mentioned_mobile_list: [wecomBot.telphone] },
    };
    superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`).send(data);
  }
  if (wxpush.appToken && wxpush.uid) {
    const data = {
      appToken: wxpush.appToken,
      contentType: 1,
      summary: title,
      content: desp,
      uids: [wxpush.uid],
    };
    superagent.post("https://wxpusher.zjiecode.com/api/send/message").send(data);
  }
};

// 并行控制器
const limit = pLimit(5);

// 执行每个账户任务
const handleAccount = async (account) => {
  const { userName, password } = account;
  const userNameInfo = mask(userName, 3, 7);
  let totalBonusSpace = 0;
  const resultLogs = [];

  if (userName && password) {
    try {
      logger.info(`账户 ${userNameInfo} 开始执行`);
      const cloudClient = new CloudClient(userName, password);
      await cloudClient.login();

      // 执行个人任务
      const taskResult = await doTask(cloudClient);
      taskResult.forEach((res) => {
        logger.info(res);
        resultLogs.push(res);
      });

      // 执行家庭签到任务
      const { result: familyResult, totalBonusSpace: bonusSpace } =
        await doFamilyTask(cloudClient);
      familyResult.forEach((res) => {
        logger.info(res);
        resultLogs.push(res);
      });
      totalBonusSpace += bonusSpace;

      return { logs: resultLogs, bonusSpace: totalBonusSpace };
    } catch (error) {
      logger.error(`账户 ${userNameInfo} 执行出错: ${error.message}`);
    }
  }
  return { logs: [], bonusSpace: 0 };
};

// 主函数，处理所有账户
async function main() {
  const results = await Promise.all(
    accounts.map((account) => limit(() => handleAccount(account)))
  );

  const totalBonusSpace = results.reduce(
    (acc, result) => acc + result.bonusSpace,
    0
  );
  const allLogs = results.flatMap((result) => result.logs);
  allLogs.push(`所有账户家庭签到总获取空间：${totalBonusSpace}M`);
  const finalLog = allLogs.join("\n");
  logger.info(finalLog);
  return finalLog;
}

// 程序入口
(async () => {
  try {
    const content = await main();
    pushNotification("天翼云盘自动签到任务", content);
  } catch (error) {
    logger.error(`程序执行失败: ${error.message}`);
  }
})();
