/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 重复日程推算引擎
 *
 * 核心策略：不采用闭式数学公式（如 modulo 天数差），而是从基准日期开始
 * 逐日/逐周/逐月正向生成所有实例，直到覆盖目标日期为止。
 *
 * 选此策略而非闭式公式的原因：
 * 1. after-count 结束条件无法用简单的天数差表达
 * 2. 跨月/跨年边界时大小月天数不同，闭式计算容易出错
 * 3. weekly 多选指定周内日期的场景，正向生成更直观
 * 4. deletedInstances 排除逻辑在生成完后统一过滤，实现简单
 */

import { Task } from '../types';

/**
 * 将 "YYYY-MM-DD" 解析为 Date 对象
 *
 * 使用中午 12:00 作为固定时刻，而不是 00:00，
 * 原因：避免因时区/DST 导致日期偏移 ——
 *   new Date(2024, 2, 10, 0, 0, 0) 在某些时区可能落在前一天的 23:00
 *   new Date(2024, 2, 10, 12, 0, 0) 在所有时区都安全落在当天
 */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

/** 将 Date 对象格式化为 "YYYY-MM-DD"（本地时间） */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 获取给定日期所在周的周日
 *
 * 注意：周起始为周日(0)。在 weekly 循环中，先统一回到周日再步进，
 * 避免跨周时因 getDay() 不一致而出错。
 */
export function getStartOfWeek(date: Date): Date {
  const result = new Date(date);
  const day = result.getDay();
  result.setDate(result.getDate() - day);
  return result;
}

/**
 * 判断一个任务在指定日期是否发生（且是否已完成）
 *
 * 推算流程：
 * 1. 先检查日期边界（不早于基准日期、不晚于 endDate）
 * 2. 检查是否在 deletedInstances 中（用户已单独删除该次实例）
 * 3. 调用 generateOccurrences 生成到目标日为止的所有实例
 * 4. 如果目标日在生成的实例列表中，则发生；否则不发生
 *
 * 此函数在日历渲染时被频繁调用（每个格子 × 每个任务），
 * generateOccurrences 每次都从头计算，日历有 42 格 + N 个任务时复杂度 O(42*N*生成成本)。
 * 如果出现性能问题，可考虑对每日结果做 memoization。
 */
export function evaluateTaskOccurrence(
  task: Task,
  targetDateStr: string
): { isOccurrence: boolean; isCompleted: boolean } {
  const baseDateStr = task.date;

  // 目标日期早于基准日期 → 不可能发生
  if (targetDateStr < baseDateStr) {
    return { isOccurrence: false, isCompleted: false };
  }

  // 用户单独删除了这个日期的实例
  if (task.deletedInstances && task.deletedInstances.includes(targetDateStr)) {
    return { isOccurrence: false, isCompleted: false };
  }

  const { frequency, endType, endDate } = task.recurrence;

  // 单次日程：只有基准日期当天发生
  if (frequency === 'none') {
    const isOccur = targetDateStr === baseDateStr;
    return { isOccurrence: isOccur, isCompleted: isOccur ? !!task.completed : false };
  }

  // 截止日期已过
  if (endType === 'on-date' && endDate && targetDateStr > endDate) {
    return { isOccurrence: false, isCompleted: false };
  }

  // 生成到目标日的所有实例，检查目标日是否在其中
  const occurrences = generateOccurrences(task, targetDateStr);
  const isOccur = occurrences.includes(targetDateStr);

  if (isOccur) {
    const isComp = !!task.completedInstances?.includes(targetDateStr);
    return { isOccurrence: true, isCompleted: isComp };
  }

  return { isOccurrence: false, isCompleted: false };
}

/**
 * 将 RecurrenceRule 展开为 日期字符串数组
 *
 * @param task        - 任务对象（用其 date 和 recurrence 字段）
 * @param maxDateStr  - 生成上限日期，结果不会超出此日期
 *                      注意：此参数仅作"硬上限"，实际的结束日期受 endDate/endCount 约束
 *
 * @returns 排序后的 YYYY-MM-DD 字符串数组，不含 deletedInstances 中列出的日期
 *
 * 安全限制：最大迭代 3000 次，防止因配置错误（如 interval=0）导致无限循环。
 * 实际使用中即使每 1 天重复一次，3000 次也覆盖了约 8 年，应该足够。
 */
export function generateOccurrences(task: Task, maxDateStr: string): string[] {
  const baseDateStr = task.date;
  if (maxDateStr < baseDateStr) return [];

  const { frequency, interval = 1, weekdays, endType, endDate, endCount } = task.recurrence;

  // 非循环任务直接返回基准日期
  if (frequency === 'none') {
    return [baseDateStr];
  }

  // 上限日期取 endDate 与 maxDateStr 中较早者
  const limitDateStr =
    endType === 'on-date' && endDate && endDate < maxDateStr ? endDate : maxDateStr;
  // 重复次数上限
  const targetEndCount = endType === 'after-count' && endCount ? endCount : Infinity;

  const occurrences: string[] = [];
  const baseDate = parseLocalDate(baseDateStr);
  const limitDate = parseLocalDate(limitDateStr);

  let current = new Date(baseDate);
  const maxIterations = 3000;
  let iter = 0;

  if (frequency === 'daily') {
    // 每天重复：每次直接 +interval 天
    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      occurrences.push(formatLocalDate(current));
      current.setDate(current.getDate() + interval);
    }
  } else if (frequency === 'weekly') {
    // 每周重复：以周为单位步进
    // 每步先回到周日，统一周起始参考点，避免 weekDiff 计算因跨周偏移
    const baseWeekStart = getStartOfWeek(baseDate);

    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      const currentWeekStart = getStartOfWeek(current);
      // 当前周距基准周的偏移量（周数）
      const weekDiff = Math.round(
        (currentWeekStart.getTime() - baseWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
      );

      if (weekDiff % interval === 0) {
        if (weekdays && weekdays.length > 0) {
          // 指定的周内日期（如周一三五）
          const sortedWeekdays = [...weekdays].sort((a, b) => a - b);
          for (const wd of sortedWeekdays) {
            const dayOfThisWeek = new Date(currentWeekStart);
            dayOfThisWeek.setDate(dayOfThisWeek.getDate() + wd);

            if (dayOfThisWeek >= baseDate && dayOfThisWeek <= limitDate) {
              const dateStr = formatLocalDate(dayOfThisWeek);
              if (!occurrences.includes(dateStr)) {
                occurrences.push(dateStr);
              }
              if (occurrences.length >= targetEndCount) break;
            }
          }
        } else {
          // 没有指定周内日期 → 保持与基准日期相同的 weekday
          if (current >= baseDate) {
            occurrences.push(formatLocalDate(current));
          }
        }
      }

      // 跳到下周日（步进一周）。注意：不能简单地 current.setDate(current.getDate() + 7)
      // 因为 current 可能在周中，setDate(+7) 后再 getStartOfWeek 可能仍落在同一周。
      // 正确做法：从本周日 +7 天，确保下周的起始。详见 getStartOfWeek 注释。
      current = new Date(currentWeekStart);
      current.setDate(current.getDate() + 7);
    }
  } else if (frequency === 'monthly') {
    // 每月重复：以月为单位步进，支持两种模式
    const { monthlyType, nthWeek, nthWeekday } = task.recurrence;
    const baseDay = baseDate.getDate();
    let monthsElapsed = 0;

    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      if (monthsElapsed % interval === 0) {
        const year = current.getFullYear();
        const month = current.getMonth();
        let candidate: Date | null = null;

        if (monthlyType === 'nth-weekday' && nthWeek !== undefined && nthWeekday !== undefined) {
          // 模式A：每月第 N 个星期 X（如"第二个周二"）
          if (nthWeek === -1) {
            // 最后一个星期 X：从月末向前找到第一个匹配的 weekday
            const d = new Date(year, month + 1, 0, 12, 0, 0);
            while (d.getDay() !== nthWeekday) {
              d.setDate(d.getDate() - 1);
            }
            candidate = d;
          } else {
            // 第 N 个星期 X：从月首找到第一个匹配的 weekday，再加 (N-1)*7 天
            const d = new Date(year, month, 1, 12, 0, 0);
            while (d.getDay() !== nthWeekday) {
              d.setDate(d.getDate() + 1);
            }
            d.setDate(d.getDate() + (nthWeek - 1) * 7);
            if (d.getMonth() === month) {
              candidate = d;
            }
          }
        } else {
          // 模式B：每月第 X 日（如每月15日）
          // 处理大小月差异：若基准日是 31 日而当前月只有 30 天，则取 30 日
          const maxDaysInMonth = new Date(year, month + 1, 0, 12, 0, 0).getDate();
          const targetDay = Math.min(baseDay, maxDaysInMonth);
          candidate = new Date(year, month, targetDay, 12, 0, 0);
        }

        if (candidate && candidate >= baseDate && candidate <= limitDate) {
          const dateStr = formatLocalDate(candidate);
          if (!occurrences.includes(dateStr)) {
            occurrences.push(dateStr);
          }
        }
      }

      // 步进到下一月
      monthsElapsed += 1;
      current = new Date(baseDate.getFullYear(), baseDate.getMonth() + monthsElapsed, 1, 12, 0, 0);
    }
  } else if (frequency === 'yearly') {
    // 每年重复：以年为单位步进
    const baseMonth = baseDate.getMonth();
    const baseDay = baseDate.getDate();
    let yearsElapsed = 0;

    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      if (yearsElapsed % interval === 0) {
        const year = current.getFullYear();
        // 处理闰年/大小月：若 2 月 29 日不存在则取 28 日
        const maxDaysInMonth = new Date(year, baseMonth + 1, 0, 12, 0, 0).getDate();
        const targetDay = Math.min(baseDay, maxDaysInMonth);

        const candidate = new Date(year, baseMonth, targetDay, 12, 0, 0);
        if (candidate >= baseDate && candidate <= limitDate) {
          occurrences.push(formatLocalDate(candidate));
        }
      }

      yearsElapsed += 1;
      current = new Date(baseDate.getFullYear() + yearsElapsed, baseDate.getMonth(), 1, 12, 0, 0);
    }
  }

  // 统一过滤被用户单独删除的实例
  const activeOccurrences = occurrences.filter(
    (d) => !(task.deletedInstances && task.deletedInstances.includes(d))
  );

  // 再次截断到 targetEndCount（weekly 模式下可能有重复入列的情况）
  return activeOccurrences.slice(0, targetEndCount);
}
