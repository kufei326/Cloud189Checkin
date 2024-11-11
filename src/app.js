/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
    },
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

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败, 次数不足`);
  } else {
    result.push(`第${index}次抽奖成功, 抽奖获得${res.prizeName}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 任务 1. 签到 2. 天天抽红包 3. 自动备份抽红包
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

// 获取家庭任务签到空间并累计总和
const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  const result = [];
  let familyBonusTotal = 0;

  if (familyInfoResp) {
    for (let index = 0; index < familyInfoResp.length; index += 1) {
      const { familyId } = familyInfoResp[index];
      const res = await cloudClient.familyUserSign('108981821788983');
      const bonusSpace = res.bonusSpace || 0;
      familyBonusTotal += bonusSpace;
      result.push(
        `家庭任务${res.signStatus ? "已经签到过了，" : ""}签到获得${bonusSpace}M空间`
      );
    }
  }
  return { result, familyBonusTotal };
};

// 推送方法
const pushServerChan = (title, desp) => {
  if (!serverChan.sendKey) return;
  superagent
    .post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .type("form")
    .send({ title, desp })
    .end((err, res) => {
      if (err) logger.error(`ServerChan推送失败:${JSON.stringify(err)}`);
      else logger.info("ServerChan推送成功");
    });
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBot.botToken && telegramBot.chatId)) return;
  superagent
    .post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
    .type("form")
    .send({ chat_id: telegramBot.chatId, text: `${title}\n\n${desp}` })
    .end((err) => {
      if (err) logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
      else logger.info("TelegramBot推送成功");
    });
};

const pushWecomBot = (title, desp) => {
  if (!(wecomBot.key && wecomBot.telphone)) return;
  superagent
    .post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
    .send({
      msgtype: "text",
      text: { content: `${title}\n\n${desp}`, mentioned_mobile_list: [wecomBot.telphone] },
    })
    .end((err) => {
      if (err) logger.error(`wecomBot推送失败:${JSON.stringify(err)}`);
      else logger.info("wecomBot推送成功");
    });
};

const pushWxPusher = (title, desp) => {
  if (!(wxpush.appToken && wxpush.uid)) return;
  superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send({
      appToken: wxpush.appToken,
      contentType: 1,
      summary: title,
      content: desp,
      uids: [wxpush.uid],
    })
    .end((err) => {
      if (err) logger.error(`wxPusher推送失败:${JSON.stringify(err)}`);
      else logger.info("wxPusher推送成功");
    });
};

const push = (title, desp) => {
  pushServerChan(title, desp);
  pushTelegramBot(title, desp);
  pushWecomBot(title, desp);
  pushWxPusher(title, desp);
};

// 开始执行程序
async function main() {
  let totalFamilyBonusSpace = 0;

  for (let index = 0; index < accounts.length; index += 1) {
    const { userName, password } = accounts[index];
    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`账户 ${userNameInfo} 开始执行`);
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();

        const taskResult = await doTask(cloudClient);
        taskResult.forEach((r) => logger.log(r));

        const { result: familyResult, familyBonusTotal } = await doFamilyTask(cloudClient);
        familyResult.forEach((r) => logger.log(r));
        totalFamilyBonusSpace += familyBonusTotal;

        const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
        logger.log(
          `个人总容量：${(cloudCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2)}G, 家庭总容量：${(familyCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2)}G`
        );
      } catch (e) {
        logger.error(e);
      } finally {
        logger.log(`账户 ${userNameInfo} 执行完毕`);
      }
    }
  }

  logger.log(`所有账号累计签到获得的家庭空间：${(totalFamilyBonusSpace / 1024).toFixed(2)}G`);
}

(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push("天翼云盘自动签到任务", content);
    recording.erase();
  }
})();
