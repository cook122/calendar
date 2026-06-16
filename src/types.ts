/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskCategory = 'work' | 'personal' | 'habit' | 'other';
export type RecurrenceFrequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RecurrenceEndType = 'never' | 'on-date' | 'after-count';

export interface RecurrenceRule {
  /** 重复频率 */
  frequency: RecurrenceFrequency;

  /** 间隔基数：每 N 个 frequency 重复一次。如 interval=2 + frequency=daily → 每2天 */
  interval: number;

  /** 周重复专用：选中星期，0=周日 1=周一 ... 6=周六 */
  weekdays?: number[];

  /** 结束条件类型：永不 / 截至日期 / 重复N次后 */
  endType: RecurrenceEndType;

  /** endType=on-date 时的截止日期 */
  endDate?: string;

  /** endType=after-count 时的重复次数上限 */
  endCount?: number;

  /** 快速预设类型，表单下拉框选中值（非自定义时为快捷入口） */
  presetType?: 'none' | 'daily' | 'weekly-day' | 'monthly-nth-weekday' | 'monthly-day' | 'yearly-day' | 'weekday' | 'custom';

  /** 月重复模式：按每月第几日 / 按每月第几个星期几 */
  monthlyType?: 'day-of-month' | 'nth-weekday';

  /** monthlyType=nth-weekday 时，第几个（-1=最后一个） */
  nthWeek?: number;

  /** monthlyType=nth-weekday 时，星期几（0=周日） */
  nthWeekday?: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;

  /** 基准日期，循环日程以此为起点推算后续所有实例 */
  date: string;

  timeEnabled: boolean;
  startTime?: string;
  endTime?: string;
  priority: TaskPriority;
  category: TaskCategory;

  /** 重复规则（frequency='none' 表示单次日程） */
  recurrence: RecurrenceRule;

  /** 循环日程各实例的完成状态，key 为日期 YYYY-MM-DD */
  completedInstances?: string[];

  /** 被当前实例删除的日期（不影响同一系列的其他实例） */
  deletedInstances?: string[];

  /** 非循环日程的完成状态 */
  completed?: boolean;

  /** 提前提醒分钟数。 -1=不提醒 0=准时 5/15/30/60/1440 */
  remindMinutes?: number;

  /** 是否启用响铃和语音播报 */
  ringEnabled?: boolean;

  createdAt: string;
}

// 目前未在代码中使用，保留以备日历组件拆分时引用
export interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
}
