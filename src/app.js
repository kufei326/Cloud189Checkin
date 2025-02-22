/* eslint-disable no-await-in-loop */
/* cron: 0 7,19 * * *
const $ = new Env('天翼网盘签到'); */
require('dotenv').config();
const log4js = require('log4js');
const { CloudClient } = require('cloud189-sdk');
const { sendNotify } = require('./sendNotify');
// 新增环境变量处理（在日志配置之前）
const EXEC_THRESHOLD = parseInt(process.env.EXEC_THRESHOLD || 1); // 默认值为1
// 日志配置
log4js.configure({
  appenders: {
    debug: {
      type: 'console',
      layout: { type: 'pattern', pattern: '%[%d{hh:mm:ss} %p %f{1}:%l%] %m' },
    },
  },
  categories: { default: { appenders: ['debug'], level: 'debug' } },
});
const logger = log4js.getLogger();

// 调试工具
const benchmark = {
  start: Date.now(),
  lap() {
    return `${((Date.now() - this.start) / 1000).toFixed(2)}s`;
  },
};

// 新增工具函数：带超时的 Promise
function timeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms)),
  ]);
}

// 核心签到逻辑
async function stressTest(account, familyId, personalCount = 10, familyCount = 10) {
  let personalTotal = 0; let
    familyTotal = 0;
  let actualPersonal = 0; let
    actualFamily = 0;
  const report = [];

  try {
    logger.debug(`🚦 开始压力测试 (账号: ${mask(account.userName)})`);

    const client = new CloudClient(account.userName, account.password);
    await client.login().catch(() => { throw new Error('登录失败'); });
    // 获取初始容量信息
    const userSizeInfo = await client.getUserSizeInfo().catch(() => null);
    // 个人签到10连击（新增30秒超时）
    const personalPromises = Array(personalCount).fill().map(() => timeout(client.userSign(), 30000) // 30秒超时控制
      .then((res) => {
        const mb = res.netdiskBonus;
        logger.debug(`[${Date.now()}] 🎯 个人签到 ✅ 获得: ${mb}MB`);
        return mb;
      })
      .catch((err) => {
        const message = err.message.includes('超时') ? `请求超时（30秒）` : err.message;
        report.push(`[${Date.now()}] 🎯 个人签到 ❌ 获得: 0MB (原因: ${message})`);
        return 0;
      }));
    const personalResults = await Promise.allSettled(personalPromises);
    personalTotal = personalResults.reduce((sum, r) => sum + r.value, 0);
    report.push(`🎯 个人签到完成 累计获得: ${personalTotal}MB`);

    // 家庭签到10连击（新增30秒超时）
    const familyPromises = Array(familyCount).fill().map(() => timeout(client.familyUserSign(familyId), 30000) // 30秒超时控制
      .then((res) => {
        const mb = res.bonusSpace;
        logger.debug(`[${Date.now()}] 🏠 家庭签到 ✅ 获得: ${mb}MB`);
        return mb;
      })
      .catch((err) => {
        const message = err.message.includes('超时') ? `请求超时（30秒）` : err.message;
        report.push(`[${Date.now()}] 🏠 家庭签到 ❌ 获得: 0MB (原因: ${message})`);
        return 0;
      }));
    const familyResults = await Promise.allSettled(familyPromises);
    familyTotal = familyResults.reduce((sum, r) => sum + r.value, 0);
    report.push(`🏠 家庭签到完成 本次获得: ${familyTotal}MB`);
    // 获取签到后容量信息
    const afterUserSizeInfo = await client.getUserSizeInfo().catch(() => null);

    // 计算实际容量变化
    if (userSizeInfo && afterUserSizeInfo) {
      actualPersonal = (afterUserSizeInfo.cloudCapacityInfo.totalSize - userSizeInfo.cloudCapacityInfo.totalSize) / 1024 / 1024;
      actualFamily = (afterUserSizeInfo.familyCapacityInfo.totalSize - userSizeInfo.familyCapacityInfo.totalSize) / 1024 / 1024;
      report.push(`📊 实际容量变化 | 个人: ${actualPersonal.toFixed(2)}MB | 家庭: ${actualFamily.toFixed(2)}MB`);
    } else {
      report.push(`⚠️ 容量信息获取失败，无法计算实际变化`);
    }
    return {
      success: true,
      personalTotal,
      familyTotal,
      actualFamily,
      report: `账号 ${mask(account.userName)}\n${report.join('\n')}`,
    };
  } catch (e) {
    return {
      success: false,
      report: `❌ ${mask(account.userName)} 签到失败: ${e.message}`,
    };
  }
}

// 辅助方法
function mask(s) {
  return s.replace(/(\d{3})\d+(\d{4})/, '$1****$2');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 修改后的执行测试
(async () => {
  try {
    logger.debug('🔥 启动专项压力测试');
    const accounts = require('./accounts');
    const familyId = process.env.FAMILYID;

    if (!familyId) throw new Error('未配置环境变量 FAMILYID');

    // 新增：在主作用域声明变量
    let mainAccountClient = null;
    let initialSizeInfo = null;
    let finalSizeInfo = null;

    // 仅当存在账号时初始化主账号
    if (accounts.length > 0) {
      const mainAccount = accounts[0];
      mainAccountClient = new CloudClient(mainAccount.userName, mainAccount.password);
      await mainAccountClient.login().catch((e) => {
        throw new Error(`主账号登录失败: ${e.message}`);
      });
      initialSizeInfo = await mainAccountClient.getUserSizeInfo().catch(() => null);
      if (!initialSizeInfo) throw new Error('无法获取初始容量信息');
      logger.debug(`🏠 初始家庭容量: ${initialSizeInfo.familyCapacityInfo.totalSize} Bytes`);
    }
    let totalFamily = 0;
    let totalActualFamily = 0;
    const reports = [];

    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      if (!account.userName || !account.password) {
        logger.error(`账号配置错误: accounts[${index}]`);
        continue;
      }
      // 新增签到次数控制逻辑
      let personalCount = 10;
      let familyCount = 10;

      if (EXEC_THRESHOLD === 1) {
        if (index === 0) { // 第一个账号
          personalCount = 10;
          familyCount = 10;
        } else { // 其他账号
          personalCount = 0;
          familyCount = 10;
        }
      } else { // 其他账号
        personalCount = EXEC_THRESHOLD;
        familyCount = EXEC_THRESHOLD;
      }// 若 EXEC_THRESHOLD=0 保持默认值10
      const result = await stressTest(
        { userName: account.userName, password: account.password },
        familyId,
        personalCount,
        familyCount,
      );

      reports.push(result.report);

      if (result.success) {
        totalFamily += result.familyTotal;
        totalActualFamily += result.actualFamily;
      }

      if (accounts.length > 1 && index < accounts.length - 1) {
        await sleep(5000);
      }
    }
    // 最终容量统计（确保主账号客户端存在）
    if (mainAccountClient) {
      finalSizeInfo = await mainAccountClient.getUserSizeInfo().catch(() => null);
      if (finalSizeInfo) {
        logger.debug(`🏠 最终家庭容量: ${finalSizeInfo.familyCapacityInfo.totalSize} Bytes`);
        const actualFamilyTotal = (finalSizeInfo.familyCapacityInfo.totalSize - initialSizeInfo.familyCapacityInfo.totalSize) / 1024 / 1024;
        var finalMessage = `📈 实际家庭容量总增加: ${actualFamilyTotal.toFixed(2)}MB\n⏱️ 执行耗时: ${benchmark.lap()}`;
      }
    }

    const finalReport = [
      reports.join('\n\n'),
      `🏠 所有家庭签到累计获得: ${totalFamily}MB`,
      finalMessage || '⚠️ 无法计算实际容量变化',
    ].join('\n\n');

    sendNotify('天翼云压力测试报告', finalReport);
    logger.debug(`📊 测试结果:\n${finalReport}`);
  } catch (e) {
    logger.error('致命错误:', e.message);
    process.exit(1);
  }
})();
