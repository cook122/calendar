// 该项目通过 GitHub Actions 构建，本地不要构建

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lumina Calendar — 飞书风日程管理系统
 *
 * 功能概览:
 * - 月历 + 待办看板双视图
 * - 循环日程引擎（每日/周/月/年 + 自定义间隔 + 结束条件）
 * - 桌面 Web Notification 提醒 + Web Audio 和弦铃声
 * - 双向无限循环滚轮时间选择器
 * - 重复日程的精细删除控制（单次/后续/全部）
 * - 全本地持久化 (localStorage + 降级内存)
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Calendar as CalendarIcon, 
  CheckSquare, 
  Plus, 
  ChevronLeft, 
  ChevronRight, 
  ChevronUp,
  ChevronDown,
  Trash2, 
  Clock, 
  Settings, 
  Repeat, 
  Check, 
  X, 
  AlertCircle, 
  Tag, 
  Layers,
  Sparkles,
  Award,
  BookOpen,
  Coffee,
  Briefcase,
  HelpCircle,
  BellRing
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Task, TaskPriority, TaskCategory, RecurrenceFrequency, RecurrenceEndType, RecurrenceRule } from './types';
import {
  parseLocalDate,
  formatLocalDate,
  getStartOfWeek,
  evaluateTaskOccurrence,
  generateOccurrences
} from './utils/recurrenceEvaluator';

// Clean slate: 不留预设 mock 数据
const DEFAULT_TASKS: Task[] = [];

// 根据 RecurrenceRule 生成用户可读的中文摘要（类似飞书"重复说明"的展示）
function getRecurrenceChineseSummary(recurrence: RecurrenceRule, baseDateStr: string): string {
  if (recurrence.frequency === 'none') {
    return '单次日程，不重复';
  }
  
  const freqMap: Record<string, string> = {
    daily: '天',
    weekly: '周',
    monthly: '月',
    yearly: '年',
  };
  
  const weekOrdinal: Record<number, string> = {
    1: '第一个',
    2: '第二个',
    3: '第三个',
    4: '第四个',
    '-1': '最后一个'
  };

  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  
  const freqUnit = freqMap[recurrence.frequency] || '';
  let text = `每 ${recurrence.interval > 1 ? recurrence.interval : ''} ${freqUnit}`;
  
  if (recurrence.frequency === 'weekly' && recurrence.weekdays && recurrence.weekdays.length > 0) {
    if (recurrence.weekdays.length === 5 && [1, 2, 3, 4, 5].every(d => recurrence.weekdays?.includes(d))) {
      text = '每个工作日 (周一至周五)';
    } else {
      const sorted = [...recurrence.weekdays].sort((a, b) => {
        const valA = a === 0 ? 7 : a;
        const valB = b === 0 ? 7 : b;
        return valA - valB;
      });
      const daysStr = sorted.map(d => `周${dayNames[d]}`).join('、');
      text += `的 ${daysStr}`;
    }
  } else if (recurrence.frequency === 'monthly' && recurrence.monthlyType === 'nth-weekday' && recurrence.nthWeek && recurrence.nthWeekday !== undefined) {
    const ord = weekOrdinal[recurrence.nthWeek] || `第 ${recurrence.nthWeek} 个`;
    text = `每 ${recurrence.interval > 1 ? recurrence.interval : ''}月的${ord}周${dayNames[recurrence.nthWeekday]}`;
  }
  
  if (!text.endsWith('重复') && !text.includes('工作日')) {
    text += '重复';
  } else if (text.includes('工作日')) {
    text += '重复';
  }
  
  if (recurrence.endType === 'on-date' && recurrence.endDate) {
    text += `，直至 ${recurrence.endDate} 结束`;
  } else if (recurrence.endType === 'after-count' && recurrence.endCount) {
    text += `，共重复 ${recurrence.endCount} 次后结束`;
  } else {
    text += '，持续进行永不结束';
  }
  
  return text;
}

// Helper to calculate ordinal weekday sequence of a date (e.g. second Monday)
function getNthWeekdayOfDate(date: Date): { nthWeek: number; weekday: number } {
  const weekday = date.getDay();
  const day = date.getDate();
  const nthWeek = Math.ceil(day / 7);
  // Check if it's the last one in the month
  const temp = new Date(date);
  temp.setDate(temp.getDate() + 7);
  const isLast = temp.getMonth() !== date.getMonth();
  return { nthWeek: isLast ? -1 : nthWeek, weekday };
}

// Dynamic preset options matching Feishu dropdown
function getDynamicPresetOptions(dateStr: string) {
  const date = parseLocalDate(dateStr);
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const dayOfWeekName = dayNames[date.getDay()];
  const month = date.getMonth() + 1;
  const dayOfMonth = date.getDate();
  
  const nthInfo = getNthWeekdayOfDate(date);
  const ordMap: Record<number, string> = {
    1: '第一个',
    2: '第二个',
    3: '第三个',
    4: '第四个',
    '-1': '最后一个'
  };
  const ordName = ordMap[nthInfo.nthWeek] || `第 ${nthInfo.nthWeek} 个`;

  return [
    { value: 'none', label: '不重复' },
    { value: 'daily', label: '每天' },
    { value: 'weekly-day', label: `每周${dayOfWeekName}` },
    { value: 'monthly-nth-weekday', label: `每月${ordName}周${dayOfWeekName}` },
    { value: 'monthly-day', label: `每月${dayOfMonth}日` },
    { value: 'yearly-day', label: `每年${month}月${dayOfMonth}日` },
    { value: 'weekday', label: '每个工作日 (周一至周五)' },
    { value: 'custom', label: '自定义...' }
  ];
}

// Safely wrapped localStorage helper to prevent SecurityError crashes in restricted webview environments
// 当 localStorage 不可用时（如 Capacitor WebView 受限模式），退化到内存存储
const safeStorage = {
  getItem(key: string): string | null {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return localStorage.getItem(key);
      }
    } catch (e) {
      console.warn('localStorage getItem failed, fell back to memory', e);
    }
    return (window as any).__lumina_memory_storage?.[key] || null;
  },
  setItem(key: string, value: string): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(key, value);
        return;
      }
    } catch (e) {
      console.warn('localStorage setItem failed, fell back to memory', e);
    }
    if (typeof window !== 'undefined') {
      if (!(window as any).__lumina_memory_storage) {
        (window as any).__lumina_memory_storage = {};
      }
      (window as any).__lumina_memory_storage[key] = value;
    }
  },
  removeItem(key: string): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(key);
        return;
      }
    } catch (e) {
      console.warn('localStorage removeItem failed, fell back to memory', e);
    }
    if (typeof window !== 'undefined' && (window as any).__lumina_memory_storage) {
      delete (window as any).__lumina_memory_storage[key];
    }
  }
};

export default function App() {
  // 当前日期（组件生命周期内固定不变，用于"今日"判断）
  const actualTodayStr = useMemo(() => formatLocalDate(new Date()), []);

  // 从 localStorage 初始化任务数据。
  // 若检测到旧版 demo 数据 (task-1 ~ task-5)，自动清空以防残留。
  const [tasks, setTasks] = useState<Task[]>(() => {
    const stored = safeStorage.getItem('lumina_calendar_tasks');
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Task[];
        // Auto-clear old demo tasks to honor user request for empty slate immediately
        if (parsed.some(t => t.id === 'task-1' || t.id === 'task-2' || t.id === 'task-3' || t.id === 'task-4' || t.id === 'task-5')) {
          safeStorage.removeItem('lumina_calendar_tasks');
          safeStorage.removeItem('lumina_calendar_alerted_instances');
          return [];
        }
        return parsed;
      } catch (e) {
        console.error('Error parsing stored tasks, using default seeds', e);
      }
    }
    return DEFAULT_TASKS;
  });

  // Persist tasks whenever changed
  useEffect(() => {
    safeStorage.setItem('lumina_calendar_tasks', JSON.stringify(tasks));
  }, [tasks]);

  // 日历选择状态：选中日期 和 月历视图锚点
  const [selectedDateStr, setSelectedDateStr] = useState<string>(actualTodayStr);
  const [viewDate, setViewDate] = useState<Date>(() => parseLocalDate(actualTodayStr));

  const [activeTab, setActiveTab] = useState<'calendar' | 'tasks'>('calendar');

  // 底部弹出表单状态
  const [isAddSheetOpen, setIsAddSheetOpen] = useState<boolean>(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // 新建/编辑表单各字段
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskBaseDate, setTaskBaseDate] = useState(actualTodayStr);
  const [timeEnabled, setTimeEnabled] = useState(true);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [category, setCategory] = useState<TaskCategory>('work');
  const [remindMinutes, setRemindMinutes] = useState<number>(15);
  const [ringEnabled, setRingEnabled] = useState<boolean>(true);

  // 时间滚轮选择器（双向无限循环）
  const [activeTimePicker, setActiveTimePicker] = useState<'start' | 'end' | null>(null);
  const [tempHour, setTempHour] = useState('09');
  const [tempMinute, setTempMinute] = useState('00');

  const hourContainerRef = React.useRef<HTMLDivElement>(null);
  const minuteContainerRef = React.useRef<HTMLDivElement>(null);

  // 滚轮打开时，自动滚动到当前选中值的位置（水平和垂直居中）
  useEffect(() => {
    if (activeTimePicker) {
      // 延迟 50ms 确保弹窗 DOM 已渲染完成再滚动
      setTimeout(() => {
        const hIndex = parseInt(tempHour, 10);
        const hourContainer = hourContainerRef.current;
        if (hourContainer && hourContainer.children[hIndex]) {
          const activeEl = hourContainer.children[hIndex] as HTMLElement;
          hourContainer.scrollTo({
            top: activeEl.offsetTop - hourContainer.clientHeight / 2 + activeEl.clientHeight / 2,
            behavior: 'smooth'
          });
        }

        const mIndex = parseInt(tempMinute, 10);
        const minuteContainer = minuteContainerRef.current;
        if (minuteContainer && minuteContainer.children[mIndex]) {
          const activeEl = minuteContainer.children[mIndex] as HTMLElement;
          minuteContainer.scrollTo({
            top: activeEl.offsetTop - minuteContainer.clientHeight / 2 + activeEl.clientHeight / 2,
            behavior: 'smooth'
          });
        }
      }, 50);
    }
  }, [activeTimePicker, tempHour, tempMinute]);

  // 当前正在显示的提醒弹窗
  const [activeAlert, setActiveAlert] = useState<{
    task: Task;
    instanceDate: string;
    triggerTime: string;
  } | null>(null);

  // 已通知过的实例集合，避免重复弹窗 (key = `${taskId}-${dateStr}`)
  const [alertedInstances, setAlertedInstances] = useState<string[]>(() => {
    try {
      const stored = safeStorage.getItem('lumina_calendar_alerted_instances');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // 已被用户"稍后提醒"的实例，value 为下次触发时间戳
  const [snoozedAlerts, setSnoozedAlerts] = useState<Record<string, number>>({});

  // Persist alertedInstances
  useEffect(() => {
    safeStorage.setItem('lumina_calendar_alerted_instances', JSON.stringify(alertedInstances));
  }, [alertedInstances]);

  // 提醒轮询引擎：每 10 秒检查一次需要触发的提醒
  useEffect(() => {
    // 首次挂载时请求浏览器通知权限
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }

    const checkReminders = () => {
      const now = new Date();
      const todayStr = formatLocalDate(now);
      const nowMs = now.getTime();

      tasks.forEach((task) => {
        if (!task.timeEnabled || !task.startTime) return;

        const offset = task.remindMinutes !== undefined ? task.remindMinutes : 15;
        if (offset === -1) return; // -1 表示不提醒

        const { isOccurrence, isCompleted } = evaluateTaskOccurrence(task, todayStr);
        if (!isOccurrence || isCompleted) return;

        const [startHour, startMin] = task.startTime.split(':').map(Number);
        const eventTime = new Date(now);
        eventTime.setHours(startHour, startMin, 0, 0);

        const reminderTime = new Date(eventTime.getTime() - offset * 60 * 1000);
        const reminderTimeMs = reminderTime.getTime();

        const instanceKey = `${task.id}-${todayStr}`;

        // 如果用户点了"稍后提醒"，在 snooze 期间跳过
        const snoozeLimit = snoozedAlerts[instanceKey];
        if (snoozeLimit && nowMs < snoozeLimit) {
          return;
        }

        // 当前时间 >= 提醒时间，且差距不超过 5 分钟（防止页面刷新后触发旧提醒）
        const isTriggerActive = nowMs >= reminderTimeMs && nowMs - reminderTimeMs < 5 * 60 * 1000;

        if (isTriggerActive) {
          const hasNotified = alertedInstances.includes(instanceKey);
          const snoozePassed = snoozeLimit && nowMs >= snoozeLimit;

          if (!hasNotified || snoozePassed) {
            if (!hasNotified) {
              setAlertedInstances((prev) => [...prev, instanceKey]);
            }

            // snooze 到期后清除，以便下次可再次 snooze
            if (snoozePassed) {
              setSnoozedAlerts((prev) => {
                const copy = { ...prev };
                delete copy[instanceKey];
                return copy;
              });
            }

            // 打开应用内提醒弹窗
            setActiveAlert({
              task,
              instanceDate: todayStr,
              triggerTime: task.startTime,
            });

            // Web Audio 和弦铃声
            // 注意：在 Android WebView 中，AudioContext 创建于非用户交互回调时会处于
            // "suspended" 状态，必须调 resume() 才能播放
            if (task.ringEnabled !== false) {
              try {
                const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
                if (AudioContextClass) {
                  const ctx = new AudioContextClass();
                  // 关键：恢复被挂起的 AudioContext，否则不会出声
                  if (ctx.state === 'suspended') {
                    ctx.resume();
                  }

                  const playBeep = (freq: number, delay: number, duration: number) => {
                    setTimeout(() => {
                      const osc = ctx.createOscillator();
                      const gain = ctx.createGain();
                      osc.type = 'sine';
                      osc.frequency.setValueAtTime(freq, ctx.currentTime);
                      gain.gain.setValueAtTime(0.2, ctx.currentTime);
                      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration - 0.05);
                      osc.connect(gain);
                      gain.connect(ctx.destination);
                      osc.start();
                      osc.stop(ctx.currentTime + duration);
                    }, delay * 1000);
                  };

                  // C5 → E5 → G5 和弦
                  playBeep(523.25, 0.0, 0.4);
                  playBeep(659.25, 0.2, 0.4);
                  playBeep(783.99, 0.4, 0.6);
                }
              } catch (soundErr) {
                console.warn('Web Audio chime not supported:', soundErr);
              }
            }

            // 浏览器桌面通知（仅在安全上下文 HTTPS 下才会生效）
            // Capacitor Android WebView 中因非 HTTPS，此路不通。
            // 如需 Android 系统通知栏通知，需安装 @capacitor/local-notifications：
            //   npm install @capacitor/local-notifications
            //   npx cap sync
            // 然后替换下方代码为：
            //   import { LocalNotifications } from '@capacitor/local-notifications';
            //   LocalNotifications.schedule({ notifications: [{ title, body, id, ... }] });
            if (
              typeof window !== 'undefined' &&
              'Notification' in window &&
              window.isSecureContext &&
              Notification.permission === 'granted'
            ) {
              try {
                new Notification(`⏰ 日程提醒: ${task.title}`, {
                  body: `时间: ${task.startTime}${offset > 0 ? ` (已提前 ${offset} 分钟提醒)` : ' (开始时间)'}\n优先级: ${task.priority === 'high' ? '高 🔥' : task.priority === 'medium' ? '中 ⚡' : '低 ☕'}\n备注: ${task.description || '无'}`,
                  tag: instanceKey,
                  requireInteraction: true,
                });
              } catch (e) {
                console.error(e);
              }
            }
          }
        }
      });
    };

    checkReminders();
    const intervalId = setInterval(checkReminders, 10000);

    return () => clearInterval(intervalId);
  }, [tasks, alertedInstances, snoozedAlerts]);

  // Recurrence rule builder block states
  const [isRecurring, setIsRecurring] = useState(false);
  const [presetType, setPresetType] = useState<string>('none');
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('daily');
  const [interval, setIntervalValue] = useState<number>(1);
  const [weekdays, setWeekdays] = useState<number[]>([1]); // Default Monday
  const [monthlyType, setMonthlyType] = useState<'day-of-month' | 'nth-weekday'>('day-of-month');
  const [nthWeek, setNthWeek] = useState<number>(1);
  const [nthWeekday, setNthWeekday] = useState<number>(1);
  const [endType, setEndType] = useState<RecurrenceEndType>('never');
  const [endDate, setEndDate] = useState('2026-12-31');
  const [endCount, setEndCount] = useState<number>(10);

  // 循环日程删除确认弹窗状态
  const [selectedTaskForDelete, setSelectedTaskForDelete] = useState<{ task: Task; dateStr: string } | null>(null);

  // Filter category in tasks view
  const [categoryFilter, setCategoryFilter] = useState<'all' | TaskCategory>('all');

  // 标准 6×7 日历网格生成器（以周一为列首）
  const calendarDays = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    
    // First day of current month
    const firstDay = new Date(year, month, 1, 12, 0, 0);
    const firstDayOfWeek = firstDay.getDay();

    // 计算月首是周几，确定需要从上月补几天
    // 周一为第一列，所以：
    //   月首周一 → 补 0 天；月首周二 → 补 1 天；...；月首周日 → 补 6 天
    const daysFromPrev = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
    
    const days: { date: Date; dateStr: string; isCurrentMonth: boolean; isToday: boolean }[] = [];
    
    // Total cells = 42 (6 rows)
    const startDate = new Date(firstDay);
    startDate.setDate(firstDay.getDate() - daysFromPrev);

    for (let i = 0; i < 42; i++) {
      const current = new Date(startDate);
      current.setDate(startDate.getDate() + i);
      const str = formatLocalDate(current);
      days.push({
        date: current,
        dateStr: str,
        isCurrentMonth: current.getMonth() === month,
        isToday: str === actualTodayStr,
      });
    }
    
    return days;
  }, [viewDate, actualTodayStr]);

  // 计算每个日历日期上的任务（用于月历格子的圆点指示器）
  const dailyOccurrencesMap = useMemo(() => {
    const map: Record<string, { task: Task; isCompleted: boolean }[]> = {};
    
    calendarDays.forEach(cell => {
      const cellDateStr = cell.dateStr;
      tasks.forEach(task => {
        const { isOccurrence, isCompleted } = evaluateTaskOccurrence(task, cellDateStr);
        if (isOccurrence) {
          if (!map[cellDateStr]) map[cellDateStr] = [];
          map[cellDateStr].push({ task, isCompleted });
        }
      });
    });
    
    return map;
  }, [calendarDays, tasks]);

  // 选中日期上的任务列表（按优先级→时间排序）
  const selectedDateTasks = useMemo(() => {
    const list: { task: Task; isCompleted: boolean }[] = [];
    tasks.forEach((task) => {
      const { isOccurrence, isCompleted } = evaluateTaskOccurrence(task, selectedDateStr);
      if (isOccurrence) {
        list.push({ task, isCompleted });
      }
    });

    // 排序：高优先级优先 → 有时刻的优先 → 按开始时间先后
    return list.sort((a, b) => {
      const priorityWeights = { high: 3, medium: 2, low: 1 };
      const weightDiff = priorityWeights[b.task.priority] - priorityWeights[a.task.priority];
      if (weightDiff !== 0) return weightDiff;
      if (a.task.timeEnabled && b.task.timeEnabled) {
        return (a.task.startTime || '').localeCompare(b.task.startTime || '');
      }
      return a.task.timeEnabled ? -1 : 1;
    });
  }, [tasks, selectedDateStr]);

  // 打开新建/编辑表单。传入 taskToEdit 则为编辑模式，否则新建。
  const openAddTask = (taskToEdit?: Task) => {
    if (taskToEdit) {
      setEditingTask(taskToEdit);
      setTaskTitle(taskToEdit.title);
      setTaskDesc(taskToEdit.description || '');
      setTaskBaseDate(taskToEdit.date);
      setTimeEnabled(taskToEdit.timeEnabled);
      setStartTime(taskToEdit.startTime || '09:00');
      setEndTime(taskToEdit.endTime || '10:00');
      setPriority(taskToEdit.priority);
      setCategory(taskToEdit.category);
      setRemindMinutes(taskToEdit.remindMinutes !== undefined ? taskToEdit.remindMinutes : 15);
      setRingEnabled(taskToEdit.ringEnabled !== undefined ? taskToEdit.ringEnabled : true);

      const hasRecur = taskToEdit.recurrence.frequency !== 'none';
      setIsRecurring(hasRecur);
      setPresetType(taskToEdit.recurrence.presetType || (hasRecur ? 'custom' : 'none'));
      setFrequency(hasRecur ? taskToEdit.recurrence.frequency : 'daily');
      setIntervalValue(taskToEdit.recurrence.interval || 1);
      setWeekdays(taskToEdit.recurrence.weekdays || [1]);
      setMonthlyType(taskToEdit.recurrence.monthlyType || 'day-of-month');
      setNthWeek(taskToEdit.recurrence.nthWeek || 1);
      setNthWeekday(taskToEdit.recurrence.nthWeekday || 1);
      setEndType(taskToEdit.recurrence.endType || 'never');
      setEndDate(taskToEdit.recurrence.endDate || '2026-12-31');
      setEndCount(taskToEdit.recurrence.endCount || 10);
    } else {
      setEditingTask(null);
      setTaskTitle('');
      setTaskDesc('');
      setTaskBaseDate(selectedDateStr);
      setTimeEnabled(true);
      setStartTime('09:00');
      setEndTime('10:00');
      setPriority('medium');
      setCategory('work');
      setFormTab('event');
      setRemindMinutes(15);
      setRingEnabled(true);

      setIsRecurring(false);
      setPresetType('none');
      setFrequency('daily');
      setIntervalValue(1);
      const tempDate = parseLocalDate(selectedDateStr);
      setWeekdays([tempDate.getDay()]); // Default to currently selected date's day of week
      setMonthlyType('day-of-month');
      const nthInfo = getNthWeekdayOfDate(tempDate);
      setNthWeek(nthInfo.nthWeek);
      setNthWeekday(nthInfo.weekday);
      setEndType('never');
      setEndDate('2026-12-31');
      setEndCount(10);
    }
    setIsAddSheetOpen(true);
  };

  // 保存新建/编辑的任务。根据 presetType 将快捷选项转为 RecurrenceRule 结构。
  const handleSaveTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;

    const currentBaseDate = parseLocalDate(taskBaseDate);
    const dayOfWeek = currentBaseDate.getDay();
    const nthInfo = getNthWeekdayOfDate(currentBaseDate);

    let parsedIsRecurring = presetType !== 'none';
    let finalFrequency: RecurrenceFrequency = 'daily';
    let finalInterval = 1;
    let finalWeekdays: number[] | undefined = undefined;
    let finalMonthlyType: 'day-of-month' | 'nth-weekday' | undefined = undefined;
    let finalNthWeek: number | undefined = undefined;
    let finalNthWeekday: number | undefined = undefined;
    
    if (presetType === 'daily') {
      finalFrequency = 'daily';
      finalInterval = 1;
    } else if (presetType === 'weekly-day') {
      finalFrequency = 'weekly';
      finalInterval = 1;
      finalWeekdays = [dayOfWeek];
    } else if (presetType === 'monthly-nth-weekday') {
      finalFrequency = 'monthly';
      finalInterval = 1;
      finalMonthlyType = 'nth-weekday';
      finalNthWeek = nthInfo.nthWeek;
      finalNthWeekday = nthInfo.weekday;
    } else if (presetType === 'monthly-day') {
      finalFrequency = 'monthly';
      finalInterval = 1;
      finalMonthlyType = 'day-of-month';
    } else if (presetType === 'yearly-day') {
      finalFrequency = 'yearly';
      finalInterval = 1;
    } else if (presetType === 'weekday') {
      finalFrequency = 'weekly';
      finalInterval = 1;
      finalWeekdays = [1, 2, 3, 4, 5];
    } else if (presetType === 'custom') {
      finalFrequency = frequency;
      finalInterval = Number(interval);
      if (frequency === 'weekly') {
        finalWeekdays = weekdays;
      } else if (frequency === 'monthly') {
        finalMonthlyType = monthlyType;
        if (monthlyType === 'nth-weekday') {
          finalNthWeek = nthWeek;
          finalNthWeekday = nthWeekday;
        }
      }
    }

    const recurrenceBuilt: RecurrenceRule = parsedIsRecurring ? {
      frequency: finalFrequency,
      interval: finalInterval,
      weekdays: finalWeekdays,
      monthlyType: finalMonthlyType,
      nthWeek: finalNthWeek,
      nthWeekday: finalNthWeekday,
      endType: 'never',
      presetType: presetType as any
    } : {
      frequency: 'none',
      interval: 1,
      endType: 'never',
      presetType: 'none'
    };

    if (editingTask) {
      // Editing Mode
      const updated: Task = {
        ...editingTask,
        title: taskTitle.trim(),
        description: taskDesc.trim(),
        date: taskBaseDate,
        timeEnabled,
        startTime: timeEnabled ? startTime : undefined,
        endTime: timeEnabled ? endTime : undefined,
        priority,
        category,
        recurrence: recurrenceBuilt,
        remindMinutes,
        ringEnabled,
      };

      setTasks(prev => prev.map(t => t.id === editingTask.id ? updated : t));
    } else {
      // New Mode
      const newTask: Task = {
        id: `task-${Date.now()}`,
        title: taskTitle.trim(),
        description: taskDesc.trim(),
        date: taskBaseDate,
        timeEnabled,
        startTime: timeEnabled ? startTime : undefined,
        endTime: timeEnabled ? endTime : undefined,
        priority,
        category,
        recurrence: recurrenceBuilt,
        completedInstances: [],
        deletedInstances: [],
        completed: false,
        remindMinutes,
        ringEnabled,
        createdAt: new Date().toISOString(),
      };
      setTasks(prev => [...prev, newTask]);
    }

    setIsAddSheetOpen(false);
    setEditingTask(null);
  };

  // 切换任务完成状态。循环日程用 completedInstances 标记单次完成，非循环用 completed。
  const handleToggleComplete = (task: Task) => {
    if (task.recurrence.frequency === 'none') {
      // Single occurrence task
      setTasks(prev => prev.map(t => {
        if (t.id === task.id) {
          return { ...t, completed: !t.completed };
        }
        return t;
      }));
    } else {
      // Recurring task - toggle current date in completedInstances
      const isCurrentlyCompleted = task.completedInstances?.includes(selectedDateStr);
      setTasks(prev => prev.map(t => {
        if (t.id === task.id) {
          const currentList = t.completedInstances || [];
          const updatedList = isCurrentlyCompleted
            ? currentList.filter(d => d !== selectedDateStr)
            : [...currentList, selectedDateStr];
          return { ...t, completedInstances: updatedList };
        }
        return t;
      }));
    }
  };

  // "仅此日程"：将当前日期加入 deletedInstances，保留系列中其他实例
  const handleDeleteOccurrenceOnly = () => {
    if (!selectedTaskForDelete) return;
    const { task, dateStr } = selectedTaskForDelete;

    setTasks(prev => prev.map(t => {
      if (t.id === task.id) {
        const deletedArr = t.deletedInstances || [];
        return {
          ...t,
          deletedInstances: [...deletedArr, dateStr]
        };
      }
      return t;
    }));
    
    setSelectedTaskForDelete(null);
  };

  // "此日程及后续"：将截至日期设为当前日期的前一天
  // 若删除的是第一个实例，等价于删除整个系列
  // 选择前一天作为 endDate 是因为 generateOccurrences 使用 endDate 作为硬上限，
  // 目标日 (dateStr) 当天不会被包含，以此达到"从今天起停止"的效果
  const handleDeleteThisAndFollowing = () => {
    if (!selectedTaskForDelete) return;
    const { task, dateStr } = selectedTaskForDelete;

    if (dateStr === task.date) {
      // Deleting first occurrence and following is equivalent to deleting the whole series
      setTasks(prev => prev.filter(t => t.id !== task.id));
    } else {
      // Find yesterday relative to selected dateStr
      const targetDate = parseLocalDate(dateStr);
      targetDate.setDate(targetDate.getDate() - 1);
      const yesterdayStr = formatLocalDate(targetDate);

      setTasks(prev => prev.map(t => {
        if (t.id === task.id) {
          return {
            ...t,
            recurrence: {
              ...t.recurrence,
              endType: 'on-date',
              endDate: yesterdayStr
            }
          };
        }
        return t;
      }));
    }
    setSelectedTaskForDelete(null);
  };

  // "所有日程"：直接从 tasks 数组中删除该任务
  const handleDeleteEntireSeries = () => {
    if (!selectedTaskForDelete) return;
    const { task } = selectedTaskForDelete;

    setTasks(prev => prev.filter(t => t.id !== task.id));
    setSelectedTaskForDelete(null);
  };

  // 清空所有数据（含提醒记录），刷新到今日
  const handleClearAllTasks = () => {
    if (window.confirm('确定要清空所有日程和测试数据吗？此操作不可撤销。')) {
      setTasks([]);
      safeStorage.removeItem('lumina_calendar_tasks');
      safeStorage.removeItem('lumina_calendar_alerted_instances');
      setSelectedDateStr(actualTodayStr);
      setViewDate(parseLocalDate(actualTodayStr));
    }
  };

  const handlePrevMonth = () => {
    setViewDate((prev) => {
      const date = new Date(prev);
      date.setMonth(date.getMonth() - 1);
      return date;
    });
  };

  const handleNextMonth = () => {
    setViewDate((prev) => {
      const date = new Date(prev);
      date.setMonth(date.getMonth() + 1);
      return date;
    });
  };

  // 周重复中的星期多选，至少保留一个选中
  const toggleWeekday = (dayIdx: number) => {
    setWeekdays(prev => {
      if (prev.includes(dayIdx)) {
        if (prev.length === 1) return prev; // Keep at least one checked
        return prev.filter(d => d !== dayIdx);
      } else {
        return [...prev, dayIdx];
      }
    });
  };

  const currentMonthLabel = `${viewDate.getFullYear()}年 ${viewDate.getMonth() + 1}月`;

  // 当月所有任务的实例列表（任务看板视图用）
  const allTasksOccurrences = useMemo(() => {
    // Collect all valid occurrences for all tasks in the current view's month for a unified checklist
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const startDate = new Date(year, month, 1, 12, 0, 0);
    const endDate = new Date(year, month + 1, 0, 12, 0, 0);
    
    const list: { id: string; task: Task; dateStr: string; isCompleted: boolean }[] = [];
    
    let current = new Date(startDate);
    while (current <= endDate) {
      const dStr = formatLocalDate(current);
      tasks.forEach(task => {
        if (categoryFilter !== 'all' && task.category !== categoryFilter) return;
        
        const { isOccurrence, isCompleted } = evaluateTaskOccurrence(task, dStr);
        if (isOccurrence) {
          list.push({
            id: `${task.id}-${dStr}`,
            task,
            dateStr: dStr,
            isCompleted
          });
        }
      });
      current.setDate(current.getDate() + 1);
    }

    return list.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  }, [tasks, categoryFilter, viewDate]);

  // 重复规则预览文本（根据表单当前选项实时生成）
  const liveRecurrencePreview = useMemo(() => {
    const currentBaseDate = parseLocalDate(taskBaseDate);
    const dayOfWeek = currentBaseDate.getDay();
    const nthInfo = getNthWeekdayOfDate(currentBaseDate);

    let parsedIsRecurring = presetType !== 'none';
    let finalFrequency: RecurrenceFrequency = 'daily';
    let finalInterval = 1;
    let finalWeekdays: number[] | undefined = undefined;
    let finalMonthlyType: 'day-of-month' | 'nth-weekday' | undefined = undefined;
    let finalNthWeek: number | undefined = undefined;
    let finalNthWeekday: number | undefined = undefined;
    
    if (presetType === 'daily') {
      finalFrequency = 'daily';
      finalInterval = 1;
    } else if (presetType === 'weekly-day') {
      finalFrequency = 'weekly';
      finalInterval = 1;
      finalWeekdays = [dayOfWeek];
    } else if (presetType === 'monthly-nth-weekday') {
      finalFrequency = 'monthly';
      finalInterval = 1;
      finalMonthlyType = 'nth-weekday';
      finalNthWeek = nthInfo.nthWeek;
      finalNthWeekday = nthInfo.weekday;
    } else if (presetType === 'monthly-day') {
      finalFrequency = 'monthly';
      finalInterval = 1;
      finalMonthlyType = 'day-of-month';
    } else if (presetType === 'yearly-day') {
      finalFrequency = 'yearly';
      finalInterval = 1;
    } else if (presetType === 'weekday') {
      finalFrequency = 'weekly';
      finalInterval = 1;
      finalWeekdays = [1, 2, 3, 4, 5];
    } else if (presetType === 'custom') {
      finalFrequency = frequency;
      finalInterval = Number(interval);
      if (frequency === 'weekly') {
        finalWeekdays = weekdays;
      } else if (frequency === 'monthly') {
        finalMonthlyType = monthlyType;
        if (monthlyType === 'nth-weekday') {
          finalNthWeek = nthWeek;
          finalNthWeekday = nthWeekday;
        }
      }
    }

    const dummyRecurrence: RecurrenceRule = parsedIsRecurring ? {
      frequency: finalFrequency,
      interval: finalInterval,
      weekdays: finalWeekdays,
      monthlyType: finalMonthlyType,
      nthWeek: finalNthWeek,
      nthWeekday: finalNthWeekday,
      endType: 'never'
    } : {
      frequency: 'none',
      interval: 1,
      endType: 'never'
    };

    return getRecurrenceChineseSummary(dummyRecurrence, taskBaseDate);
  }, [presetType, frequency, interval, weekdays, monthlyType, nthWeek, nthWeekday, taskBaseDate]);

  // 分类标签样式映射表
  const CATEGORY_STYLES: Record<TaskCategory, { label: string; bg: string; text: string; border: string; dot: string }> = {
    work: { label: '工作', bg: 'bg-[#F4F6F9]', text: 'text-[#1E293B]', border: 'border-[#E2E8F0]', dot: 'bg-black' },
    personal: { label: '个人', bg: 'bg-[#FAF5FF]', text: 'text-[#6B21A8]', border: 'border-[#F3E8FF]', dot: 'bg-purple-500' },
    habit: { label: '习惯', bg: 'bg-[#ECFDF5]', text: 'text-[#065F46]', border: 'border-[#D1FAE5]', dot: 'bg-emerald-500' },
    other: { label: '其他', bg: 'bg-[#F8FAFC]', text: 'text-[#475569]', border: 'border-[#E2E8F0]', dot: 'bg-slate-400' },
  };

  // 调试日志：写入本地文件 lumina_debug.log
  useEffect(() => {
    const logQueue: string[] = [];
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    const appendLog = (msg: string) => {
      logQueue.push(msg);
    };

    // 拦截 console 输出写入文件队列
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const handler = (level: string, orig: (...args: any[]) => void) => (...args: any[]) => {
      orig(...args);
      const ts = new Date().toISOString();
      const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a).slice(0, 300) : String(a))).join(' ');
      appendLog(`[${ts}] [${level}] ${msg}\n`);
    };
    console.log = handler('LOG', originalLog);
    console.warn = handler('WARN', originalWarn);
    console.error = handler('ERR', originalError);

    // 全局错误捕获
    const onErr = (e: ErrorEvent) => {
      appendLog(`[${new Date().toISOString()}] [FATAL] ${e.message} @ ${e.filename}:${e.lineno}\n`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      appendLog(`[${new Date().toISOString()}] [PROMISE] ${String(e.reason)}\n`);
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRejection);

    // 每 5 秒将队列 flush 到 storage
    flushTimer = setInterval(() => {
      if (logQueue.length === 0) return;
      const batch = logQueue.splice(0);
      const prev = safeStorage.getItem('lumina_debug_log') || '';
      // 保留最近 500 行
      const lines = (prev + batch.join('')).split('\n').filter(l => l.trim());
      safeStorage.setItem('lumina_debug_log', lines.slice(-500).join('\n'));
    }, 5000);

    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRejection);
      if (flushTimer) clearInterval(flushTimer);
      // 最后 flush 残留
      if (logQueue.length > 0) {
        const prev = safeStorage.getItem('lumina_debug_log') || '';
        const lines = (prev + logQueue.join('')).split('\n').filter(l => l.trim());
        safeStorage.setItem('lumina_debug_log', lines.slice(-500).join('\n'));
      }
    };
  }, []);


  return (
    <div className="min-h-screen w-full bg-[#FAF9F6] flex flex-col font-sans select-none antialiased text-[#1A1A1A] relative overflow-hidden">

      {/* 顶栏 — 标题 + 新建按钮 */}
      <header className="px-5 pt-4 pb-3 bg-white border-b border-slate-100 shadow-sm flex items-center justify-between shrink-0">
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-slate-900 animate-pulse"></span>
            <span className="text-[10px] uppercase tracking-widest text-[#8A94A6] font-mono">Lumina 白历</span>
          </div>
          <h1 className="text-xl font-bold font-sans text-slate-950 tracking-tight">
            {activeTab === 'calendar' ? '极简日常日历' : '待办任务看板'}
          </h1>
        </div>

        <button
          onClick={() => openAddTask()}
          className="w-9 h-9 bg-[#1E293B] hover:bg-black text-white rounded-full flex items-center justify-center transition-all shadow-md active:scale-95"
          title="新建日程"
        >
          <Plus className="w-5 h-5" />
        </button>
      </header>

      {/* 主内容区 — 可滚动 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 relative styled-scrollbar">

        {/* 视图1: 日历月视图 + 日时间线 */}
        {activeTab === 'calendar' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            {/* 月切换 + 网格 */}
            <div className="bg-white rounded-2xl border border-slate-100 p-3.5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <span className="text-base font-bold text-slate-900 font-sans tracking-tight">{currentMonthLabel}</span>
                <div className="flex items-center gap-1 bg-slate-50 rounded-lg p-0.5 border border-slate-200/50">
                  <button onClick={handlePrevMonth} className="p-1 px-1.5 hover:bg-white rounded text-slate-600 transition-colors">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={() => { setViewDate(parseLocalDate(actualTodayStr)); setSelectedDateStr(actualTodayStr); }} className="text-[10px] font-bold px-2 py-0.5 rounded hover:bg-white text-slate-800 font-sans transition-colors">
                    本日
                  </button>
                  <button onClick={handleNextMonth} className="p-1 px-1.5 hover:bg-white rounded text-slate-600 transition-colors">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 周表头：一 ~ 日 */}
              <div className="grid grid-cols-7 text-center mb-1 text-[11px] font-semibold text-slate-400 font-sans tracking-wide">
                <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
              </div>

              {/* 42 格日历网格 */}
                  <div className="grid grid-cols-7 gap-y-2.5 text-center mt-2.5">
                    {calendarDays.map((cell, idx) => {
                      const hasTasks = dailyOccurrencesMap[cell.dateStr]?.length > 0;
                      const hasIncompleteTasks = dailyOccurrencesMap[cell.dateStr]?.some(x => !x.isCompleted);
                      const isSelected = cell.dateStr === selectedDateStr;

                      return (
                        <div
                          key={idx}
                          onClick={() => setSelectedDateStr(cell.dateStr)}
                          className="relative flex flex-col items-center justify-center cursor-pointer group"
                        >
                          <div className={`
                            w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-medium font-mono transition-all
                            ${!cell.isCurrentMonth ? 'text-slate-300' : 'text-slate-800'}
                            ${cell.isToday ? 'ring-2 ring-slate-900 ring-offset-1 text-slate-950 font-black' : ''}
                            ${isSelected ? 'bg-slate-900 text-white font-bold shadow-md shadow-slate-900/10' : 'hover:bg-slate-100'}
                          `}>
                            {cell.date.getDate()}
                          </div>

                          {/* 日程小圆点指示器 */}
                          {hasTasks && (
                            <span className={`
                              absolute bottom-0 w-1.5 h-1.5 rounded-full transition-all
                              ${isSelected ? 'bg-white bg-opacity-90' : hasIncompleteTasks ? 'bg-slate-800' : 'bg-slate-300 line-through'}
                            `}></span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 选中日期的时间线 */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#8A94A6] font-mono">TIMELINE</span>
                    <h2 className="text-sm font-bold text-slate-900">
                      {selectedDateStr === actualTodayStr ? '今日即可执行' : `${selectedDateStr.slice(5)} 日程清单`}
                    </h2>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-slate-900 text-white rounded-full">
                    {selectedDateTasks.length} 个事件
                  </span>
                </div>

                {/* 日任务列表 */}
                <div className="space-y-2.5">
                  <AnimatePresence mode="popLayout">
                    {selectedDateTasks.length === 0 ? (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="bg-white rounded-2xl border border-dashed border-slate-200 p-8 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2"
                      >
                        <HelpCircle className="w-8 h-8 text-slate-300 stroke-[1.5]" />
                        <span>所选日期尚无任何已安排日程。</span>
                        <button
                          onClick={() => openAddTask()}
                          className="mt-1 text-[11px] font-semibold text-slate-800 underline underline-offset-2 hover:text-[#1A1A1A]"
                        >
                          点击快速新建一个
                        </button>
                      </motion.div>
                    ) : (
                      selectedDateTasks.map(({ task, isCompleted }) => {
                        const style = CATEGORY_STYLES[task.category];
                        return (
                          <motion.div
                            key={task.id}
                            layout
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            className={`
                              bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex items-start gap-3.5 transition-all relative overflow-hidden group
                              ${isCompleted ? 'bg-slate-50/70 opacity-60' : 'hover:border-slate-300'}
                            `}
                          >

                            {/* 勾选按钮 */}
                            <button
                              onClick={() => handleToggleComplete(task)}
                              className={`
                                mt-1 w-5 h-5 rounded-full border flex items-center justify-center transition-all cursor-pointer shrink-0
                                ${isCompleted ? 'bg-[#1E293B] border-[#1E293B] text-white' : 'border-slate-300 hover:border-slate-500'}
                              `}
                            >
                              {isCompleted && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                            </button>

                            {/* 任务信息 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <h3 className={`text-sm font-bold tracking-tight text-slate-900 truncate ${isCompleted ? 'line-through text-slate-400' : ''}`}>
                                  {task.title}
                                </h3>
                              </div>

                              {task.description && (
                                <p className={`text-[11px] leading-relaxed mt-1 text-slate-500 line-clamp-2 ${isCompleted ? 'line-through text-slate-400' : ''}`}>
                                  {task.description}
                                </p>
                              )}

                              {/* 时间 / 循环 / 分类 */}
                              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2.5">
                                <div className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 font-mono">
                                  <Clock className="w-3 h-3 text-slate-400" />
                                  <span>{task.timeEnabled ? `${task.startTime} - ${task.endTime}` : '全天'}</span>
                                </div>

                                {task.recurrence.frequency !== 'none' && (
                                  <div className="flex items-center gap-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
                                    <Repeat className="w-2.5 h-2.5 text-slate-500 shrink-0" />
                                    <span>
                                      {task.recurrence.frequency === 'daily' && '每天重复'}
                                      {task.recurrence.frequency === 'weekly' && `每周重复(${task.recurrence.weekdays?.map(d => ['日','一','二','三','四','五','六'][d]).join(',')})`}
                                      {task.recurrence.frequency === 'monthly' && '每月重复'}
                                      {task.recurrence.frequency === 'yearly' && '每年重复'}
                                    </span>
                                  </div>
                                )}

                                <div className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-medium ${style.bg} ${style.text} border ${style.border}`}>
                                  <span className={`w-1 h-1 rounded-full ${style.dot}`}></span>
                                  <span>{style.label}</span>
                                </div>
                              </div>
                            </div>

                            {/* 编辑 / 删除按钮 */}
                            <div className="flex items-center gap-1 pl-2 shrink-0 self-center">
                              <button
                                onClick={() => openAddTask(task)}
                                className="p-1 hover:bg-slate-100 rounded text-slate-500 hover:text-slate-900 transition-colors"
                                title="编辑整个日程"
                              >
                                <Settings className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setSelectedTaskForDelete({ task, dateStr: selectedDateStr })}
                                className="p-1 hover:bg-rose-50 rounded text-slate-400 hover:text-rose-600 transition-colors"
                                title="处理/删除日程"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </motion.div>
                        );
                      })
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}

            {/* 视图2: 待办看板 */}
            {activeTab === 'tasks' && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                className="space-y-4"
              >
                {/* 分类筛选 */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full styled-scrollbar">
                  <button 
                    onClick={() => setCategoryFilter('all')}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold font-sans transition-all shrink-0 whitespace-nowrap border
                      ${categoryFilter === 'all' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}
                    `}
                  >
                    全部 6月 事件
                  </button>
                  {(['work', 'personal', 'habit', 'other'] as TaskCategory[]).map(cat => {
                    const style = CATEGORY_STYLES[cat];
                    const isSelected = categoryFilter === cat;
                    return (
                      <button
                        key={cat}
                        onClick={() => setCategoryFilter(cat)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium font-sans transition-all shrink-0 whitespace-nowrap border flex items-center gap-1.5
                          ${isSelected ? 'bg-slate-900 text-white border-slate-900 font-bold shadow-sm' : 'bg-white text-slate-600 border-slate-200/80 hover:border-slate-400'}
                        `}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`}></span>
                        <span>{style.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* 当月任务列表 */}
                <div className="space-y-3">
                  {allTasksOccurrences.length === 0 ? (
                    <div className="bg-white rounded-3xl border border-slate-100 p-12 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
                      <CheckSquare className="w-8 h-8 text-slate-300 stroke-[1.5]" />
                      <span>本月当前筛选分类下无任何待办任务。</span>
                    </div>
                  ) : (
                    allTasksOccurrences.map(({ id, task, dateStr, isCompleted }) => {
                      const style = CATEGORY_STYLES[task.category];
                      const [, mth, dy] = dateStr.split('-');
                      const displayDateStr = `${mth}/${dy}`;

                      return (
                        <div
                          key={id}
                          className={`
                            bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex items-start gap-3 transition-all relative overflow-hidden
                            ${isCompleted ? 'bg-slate-50/80 opacity-60' : 'hover:border-slate-300'}
                          `}
                        >
                          {/* 日期徽标 */}
                          <div className="bg-slate-100/80 border border-slate-200/50 rounded-lg px-2 py-1 flex flex-col items-center justify-center shrink-0 w-11 h-11 text-slate-700 font-mono">
                            <span className="text-[11px] font-bold leading-none">{displayDateStr}</span>
                            <span className="text-[8px] scale-90 font-bold opacity-60 uppercase mt-0.5">周{['日','一','二','三','四','五','六'][parseLocalDate(dateStr).getDay()]}</span>
                          </div>

                          <div className="flex-1 min-w-0 pt-0.5">
                            <div className="flex items-center gap-2">
                              <h4 className={`text-sm font-bold text-slate-900 truncate tracking-tight ${isCompleted ? 'line-through text-slate-400' : ''}`}>
                                {task.title}
                              </h4>
                            </div>
                            {task.description && (
                              <p className={`text-[11px] mt-0.5 text-slate-400 truncate ${isCompleted ? 'line-through' : ''}`}>
                                {task.description}
                              </p>
                            )}

                            {/* 时间 / 循环 */}
                            <div className="flex items-center gap-2 mt-2">
                              <span className="text-[10px] text-slate-400 font-mono">{task.timeEnabled ? task.startTime : '全天'}</span>
                              <span className="text-[9px] text-[#818CF8] bg-indigo-50/50 border border-indigo-100/50 px-1 py-0.5 rounded font-semibold font-sans">
                                {task.recurrence.frequency !== 'none' ? '🔁 循环日程' : '● 单次'}
                              </span>
                            </div>
                          </div>

                          {/* Trigger check from unified task tab */}
                          <button 
                            onClick={() => {
                              // Execute tick simulation safely by changing selectedDate value temporarily or directly targeting dateStr
                              const isCurrentlyCompleted = task.completedInstances?.includes(dateStr);
                              if (task.recurrence.frequency === 'none') {
                                setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed: !t.completed } : t));
                              } else {
                                setTasks(prev => prev.map(t => {
                                  if (t.id === task.id) {
                                    const currentList = t.completedInstances || [];
                                    const updatedList = isCurrentlyCompleted
                                      ? currentList.filter(d => d !== dateStr)
                                      : [...currentList, dateStr];
                                    return { ...t, completedInstances: updatedList };
                                  }
                                  return t;
                                }));
                              }
                            }}
                            className={`
                              self-center w-6 h-6 rounded-full border flex items-center justify-center transition-all cursor-pointer
                              ${isCompleted ? 'bg-slate-900 border-slate-900 text-white' : 'border-slate-300 hover:border-slate-600 bg-white'}
                            `}
                          >
                            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </motion.div>
            )}
          </div>

          {/* 底部导航栏 */}
          <footer className="bg-white border-t border-slate-100 pb-2 pt-1 flex flex-col z-40">
            <div className="h-12 px-6 flex items-center justify-around">
              <button 
                onClick={() => setActiveTab('calendar')}
                className={`flex flex-col items-center gap-1.5 transition-all w-16 ${activeTab === 'calendar' ? 'text-slate-950 font-bold scale-102' : 'text-slate-400 hover:text-slate-600'}`}
              >
                <CalendarIcon className="w-5 h-5 stroke-[2]" />
                <span className="text-[10px] tracking-tight">日历首页</span>
              </button>

              <button 
                onClick={() => setActiveTab('tasks')}
                className={`flex flex-col items-center gap-1.5 transition-all w-16 ${activeTab === 'tasks' ? 'text-slate-950 font-bold scale-102' : 'text-slate-400 hover:text-slate-600'}`}
              >
                <CheckSquare className="w-5 h-5 stroke-[2]" />
                <span className="text-[10px] tracking-tight">待办打卡</span>
              </button>
            </div>

            {/* 底部手势指示条 */}
          </footer>

          {/* 弹窗1: 新建/编辑表单（底部滑出） */}
        <AnimatePresence>
          {isAddSheetOpen && (
            <div className="absolute inset-0 bg-black/60 z-50 flex items-end justify-center">
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                className="w-full bg-white rounded-t-[32px] max-h-[92%] flex flex-col overflow-hidden"
              >

                {/* 拖拽手柄 */}
                <div className="h-8 flex items-center justify-center shrink-0 border-b border-slate-100">
                  <div className="w-12 h-1.5 bg-slate-200 rounded-full"></div>
                </div>

                {/* 顶栏 — 取消 / 完成 */}
                <div className="flex items-center justify-between px-5 py-3.5 bg-white border-b border-slate-100 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setIsAddSheetOpen(false); setEditingTask(null); }}
                    className="text-[#007AFF] hover:opacity-80 text-sm font-medium transition-opacity"
                  >
                    取消
                  </button>
                  <span className="text-sm font-bold text-slate-900 font-sans tracking-tight">
                    {editingTask ? '修改日程规则' : '新建日程'}
                  </span>
                  <button
                    type="submit"
                    form="event-creation-form"
                    className="text-[#007AFF] hover:opacity-80 text-sm font-bold transition-opacity"
                  >
                    完成
                  </button>
                </div>

                {/* 表单区域 */}
                <form
                  id="event-creation-form"
                  onSubmit={handleSaveTask}
                  className="flex-1 overflow-y-auto bg-[#F2F2F7] p-4 space-y-4 styled-scrollbar"
                >

                  {/* 卡片1: 标题 + 备注 */}
                  <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold uppercase tracking-wider text-[#8A94A6] block">日程名称</label>
                      <input 
                        type="text"
                        required
                        placeholder="日程名称"
                        value={taskTitle}
                        onChange={e => setTaskTitle(e.target.value)}
                        className="w-full text-sm font-bold text-slate-900 border-none bg-transparent placeholder-slate-400 focus:outline-none p-0.5"
                      />
                    </div>
                    <div className="h-px bg-slate-100"></div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold uppercase tracking-wider text-[#8A94A6] block">备注说明</label>
                      <textarea 
                        placeholder="添加备注信息或大纲要点 (选填)..."
                        value={taskDesc}
                        onChange={e => setTaskDesc(e.target.value)}
                        rows={2}
                        className="w-full text-xs text-slate-700 bg-transparent placeholder-slate-400 focus:outline-none p-0.5 resize-none border-none leading-relaxed"
                      />
                    </div>
                  </div>

                  {/* 卡片2: 日期 / 时间 / 分类 / 优先级 */}
                  <div className="bg-white rounded-2xl shadow-sm border border-slate-100 divide-y divide-slate-100 overflow-hidden">

                    {/* 全天开关 */}
                    <div className="flex items-center justify-between p-3.5">
                      <span className="text-xs font-bold text-slate-800">全天</span>
                      <button
                        type="button"
                        onClick={() => setTimeEnabled(prev => !prev)}
                        className={`w-10 h-5.5 rounded-full p-0.5 transition-colors duration-200 ease-in-out focus:outline-none ${
                          !timeEnabled ? 'bg-[#34C759]' : 'bg-slate-200'
                        }`}
                      >
                        <div className={`w-4.5 h-4.5 rounded-full bg-white shadow-sm transform duration-200 ease-in-out ${
                          !timeEnabled ? 'translate-x-[18px]' : 'translate-x-0'
                        }`}></div>
                      </button>
                    </div>

                    {/* 开始日期 + 时间 */}
                    <div className="flex items-center justify-between p-3.5">
                      <span className="text-xs font-bold text-slate-800">开始</span>
                      <div className="flex items-center gap-1.5 font-sans">
                        <input
                          type="date"
                          value={taskBaseDate}
                          onChange={e => setTaskBaseDate(e.target.value)}
                          className="rounded-lg bg-slate-50 hover:bg-slate-100 p-1 px-2 text-xs font-bold text-slate-800 font-mono focus:outline-none border-none text-center cursor-pointer"
                        />
                        {timeEnabled && (
                          <button
                            type="button"
                            onClick={() => {
                              const [h, m] = startTime.split(':');
                              setTempHour(h || '09');
                              setTempMinute(m || '00');
                              setActiveTimePicker('start');
                            }}
                            className="rounded-lg bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 transition-all p-1 px-2.5 text-xs font-bold text-slate-800 font-mono text-center border border-slate-100/40 flex items-center gap-1 cursor-pointer active:scale-95"
                          >
                            <Clock className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                            <span>{startTime}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 结束日期 + 时间 */}
                    <div className="flex items-center justify-between p-3.5">
                      <span className="text-xs font-bold text-slate-800">结束</span>
                      <div className="flex items-center gap-1.5 font-sans">
                        <input
                          type="date"
                          value={taskBaseDate}
                          disabled
                          className="rounded-lg bg-slate-50 p-1 px-2 text-xs font-semibold text-slate-400 font-mono border-none text-center opacity-60"
                        />
                        {timeEnabled && (
                          <button
                            type="button"
                            onClick={() => {
                              const [h, m] = endTime.split(':');
                              setTempHour(h || '10');
                              setTempMinute(m || '00');
                              setActiveTimePicker('end');
                            }}
                            className="rounded-lg bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 transition-all p-1 px-2.5 text-xs font-bold text-slate-800 font-mono text-center border border-slate-100/40 flex items-center gap-1 cursor-pointer active:scale-95"
                          >
                            <Clock className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                            <span>{endTime}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 日历分类 */}
                    <div className="flex items-center justify-between p-3.5">
                      <span className="text-xs font-bold text-slate-800">日历分类</span>
                      <select
                        value={category}
                        onChange={e => setCategory(e.target.value as TaskCategory)}
                        className="text-xs bg-slate-50 border border-slate-100 rounded-lg p-1 px-2 text-slate-850 focus:outline-none font-bold"
                      >
                        <option value="work">💼 工作标签 (Work)</option>
                        <option value="personal">💜 个人私事 (Personal)</option>
                        <option value="habit">🌿 习惯培养 (Habit)</option>
                        <option value="other">☕ 其他待办 (Other)</option>
                      </select>
                    </div>
                  </div>

                  {/* 卡片3: 重复规则设置 */}
                  <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-4">
                    <div className="space-y-1.5 font-sans">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#8A94A6] flex items-center gap-1.5">
                          <Repeat className="w-3.5 h-3.5 text-slate-700 animate-pulse" />
                          <span>重复规则设置</span>
                        </label>
                      </div>
                      
                      <select 
                        value={presetType}
                        onChange={e => {
                          const val = e.target.value;
                          setPresetType(val);
                          if (val !== 'none') {
                            setIsRecurring(true);
                          } else {
                            setIsRecurring(false);
                          }
                        }}
                        className="w-full rounded-xl border border-slate-200 p-2 text-xs bg-slate-50 text-slate-850 font-bold focus:outline-none focus:ring-1 focus:ring-slate-900"
                      >
                        {getDynamicPresetOptions(taskBaseDate).map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    {presetType === 'custom' && (
                      <div 
                        className="space-y-4 border-t border-slate-100 pt-4"
                      >
                        {/* Frequency + Interval Customization */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[9px] font-bold uppercase text-slate-400">重复频率单位</label>
                            <select 
                              value={frequency}
                              onChange={e => {
                                const freqVal = e.target.value as RecurrenceFrequency;
                                setFrequency(freqVal);
                                if (freqVal !== 'weekly') setWeekdays([1]);
                              }}
                              className="w-full rounded-xl border border-slate-200 p-2 text-xs bg-white text-slate-800 focus:ring-1 focus:ring-slate-900 focus:outline-none font-bold"
                            >
                              <option value="daily">每天 (Daily)</option>
                              <option value="weekly">每周 (Weekly)</option>
                              <option value="monthly">每月 (Monthly)</option>
                              <option value="yearly">每年 (Yearly)</option>
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label className="text-[9px] font-bold uppercase text-slate-400">间隔周期</label>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-500">每</span>
                              <input 
                                type="number" 
                                min={1} 
                                max={99}
                                value={interval}
                                onChange={e => setIntervalValue(Math.max(1, Number(e.target.value)))}
                                className="w-14 rounded-xl border border-slate-200 p-1.5 text-xs bg-white text-center font-mono font-bold focus:ring-1 focus:ring-slate-900 focus:outline-none"
                              />
                              <span className="text-xs text-slate-500">
                                {frequency === 'daily' && '天'}
                                {frequency === 'weekly' && '周'}
                                {frequency === 'monthly' && '月'}
                                {frequency === 'yearly' && '年'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Weekly Multi-Weekday Selector */}
                        {frequency === 'weekly' && (
                          <div className="space-y-1.5">
                            <label className="text-[9px] font-bold uppercase text-slate-400">指定星期级重复(多选)</label>
                            <div className="flex items-center justify-between gap-1 max-w-full overflow-x-auto pb-0.5">
                              {[1, 2, 3, 4, 5, 6, 0].map(day => {
                                const label = ['日','一','二','三','四','五','六'][day];
                                const isSelected = weekdays.includes(day);
                                return (
                                  <button
                                    type="button"
                                    key={day}
                                    onClick={() => toggleWeekday(day)}
                                    className={`
                                      w-7 h-7 rounded-full text-xs font-bold font-sans flex items-center justify-center border transition-all
                                      ${isSelected ? 'bg-slate-900 text-white border-slate-900 shadow-sm' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}
                                    `}
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Monthly Details Recurrence selector */}
                        {frequency === 'monthly' && (
                          <div className="space-y-2 border-t border-slate-100 pt-3">
                            <label className="text-[9px] font-bold uppercase text-slate-400">月份重复模式</label>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() => setMonthlyType('day-of-month')}
                                className={`py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${monthlyType === 'day-of-month' ? 'bg-slate-900 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                              >
                                按日: 每月 {parseLocalDate(taskBaseDate).getDate()} 日
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setMonthlyType('nth-weekday');
                                  const nthInfo = getNthWeekdayOfDate(parseLocalDate(taskBaseDate));
                                  setNthWeek(nthInfo.nthWeek);
                                  setNthWeekday(nthInfo.weekday);
                                }}
                                className={`py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${monthlyType === 'nth-weekday' ? 'bg-slate-900 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                              >
                                按星期: 每月{getNthWeekdayOfDate(parseLocalDate(taskBaseDate)).nthWeek === -1 ? '最后一' : '第 ' + getNthWeekdayOfDate(parseLocalDate(taskBaseDate)).nthWeek }个周{['日','一','二','三','四','五','六'][parseLocalDate(taskBaseDate).getDay()]}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {presetType !== 'none' && (
                      <div className="space-y-4 border-t border-slate-100 pt-4 font-sans">
                        {/* 重复规则文字预览 */}
                        <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-100 flex items-start gap-2">
                          <span className="text-base shrink-0 mt-0.5">💡</span>
                          <div className="space-y-0.5">
                            <span className="text-[10px] font-bold text-indigo-400 block uppercase">重复解析预览</span>
                            <p className="text-[11px] leading-relaxed font-semibold text-indigo-950 font-sans italic">
                              "{liveRecurrencePreview}"
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 卡片4: 提醒设置 */}
                  <div className="bg-white rounded-2xl shadow-sm border border-slate-100 divide-y divide-slate-100 overflow-hidden">
                    <div className="p-3.5 bg-slate-50/50 flex items-center justify-between">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-[#8A94A6] flex items-center gap-1.5">
                        <BellRing className="w-3.5 h-3.5 text-slate-700 animate-bounce" />
                        <span>提醒通知与语音播报</span>
                      </label>
                    </div>

                    {/* Remind before selector */}
                    <div className="flex items-center justify-between p-3.5">
                      <span className="text-xs font-bold text-slate-800">提醒时间</span>
                      <select 
                        value={remindMinutes}
                        onChange={e => setRemindMinutes(Number(e.target.value))}
                        className="text-xs bg-slate-50 border border-slate-100 rounded-lg p-1.5 px-2 text-slate-850 focus:outline-none font-bold cursor-pointer"
                      >
                        <option value={-1}>🔕 无 (暂不提醒)</option>
                        <option value={0}>⏰ 开始时 (准时提醒)</option>
                        <option value={5}>⏳ 5分钟前 (5 minutes before)</option>
                        <option value={15}>⏳ 15分钟前 (15 minutes before)</option>
                        <option value={30}>⏳ 30分钟前 (30 minutes before)</option>
                        <option value={60}>📅 1小时前 (1 hour before)</option>
                        <option value={1440}>📅 1天前 (1 day before)</option>
                      </select>
                    </div>

                    {/* Ring Enabled Switch Row */}
                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-slate-800">响铃及智能语音播报</span>
                        <span className="text-[9px] text-slate-400 mt-0.5 max-w-[200px]">时间到达时通过语音自动朗读及铃声提醒</span>
                      </div>
                      <button 
                        type="button"
                        onClick={() => setRingEnabled(prev => !prev)}
                        className={`w-10 h-5.5 rounded-full p-0.5 transition-colors duration-200 ease-in-out focus:outline-none shrink-0 ${
                          ringEnabled ? 'bg-[#34C759]' : 'bg-slate-200'
                        }`}
                      >
                        <div className={`w-4.5 h-4.5 rounded-full bg-white shadow-sm transform duration-200 ease-in-out ${
                          ringEnabled ? 'translate-x-[18px]' : 'translate-x-0'
                        }`}></div>
                      </button>
                    </div>
                  </div>

                  {/* 提交按钮 */}
                  <button
                    type="submit"
                    className="w-full py-3 bg-slate-950 font-bold hover:bg-black text-white rounded-xl text-xs transition-colors shadow-lg active:scale-99"
                  >
                    {editingTask ? '确认更新整个日程系列' : '确认并保存日程到列表中'}
                  </button>
                </form>

              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* 弹窗2: 循环日程删除选项 */}
        <AnimatePresence>
          {selectedTaskForDelete && (
            <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-6">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl border border-slate-100 flex flex-col gap-4 text-center"
              >
                <div className="w-12 h-12 rounded-full bg-rose-50 flex items-center justify-center mx-auto text-rose-600">
                  <AlertCircle className="w-6 h-6 stroke-[2]" />
                </div>

                <div className="space-y-1">
                  <h3 className="text-base font-bold text-slate-950">
                    {selectedTaskForDelete.task.recurrence.frequency === 'none' ? '删除当前日程' : '重复关系处理'}
                  </h3>
                  <p className="text-[12px] text-slate-500 leading-relaxed max-w-xs mx-auto">
                    您正在点击处理日程 <b>{selectedTaskForDelete.task.title}</b>。
                    {selectedTaskForDelete.task.recurrence.frequency !== 'none' && '这是一个周期循环日程。'}
                  </p>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                  {selectedTaskForDelete.task.recurrence.frequency !== 'none' ? (
                    <>
                      <button
                        onClick={handleDeleteOccurrenceOnly}
                        className="py-2.5 px-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-2xl text-left transition-colors flex flex-col gap-0.5"
                      >
                        <span className="font-bold text-slate-800 text-[12px]">此日程</span>
                        <span className="text-[10px] text-slate-400 font-normal leading-normal">仅删除当前日程，不影响系列中其他日程。</span>
                      </button>

                      <button
                        onClick={handleDeleteThisAndFollowing}
                        className="py-2.5 px-3 bg-amber-50/50 hover:bg-amber-100/60 border border-amber-200/60 rounded-2xl text-left transition-colors flex flex-col gap-0.5"
                      >
                        <span className="font-bold text-amber-900 text-[12px]">此日程及后续日程</span>
                        <span className="text-[10px] text-amber-700/80 font-normal leading-normal">删除当前及后续日程，不影响之前日程。</span>
                      </button>

                      <button
                        onClick={handleDeleteEntireSeries}
                        className="py-2.5 px-3 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-2xl text-left transition-colors flex flex-col gap-0.5 shadow-sm"
                      >
                        <span className="font-bold text-rose-950 text-[12px]">所有日程</span>
                        <span className="text-[10px] text-rose-600/80 font-normal leading-normal">删除系列中的所有日程。</span>
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={handleDeleteEntireSeries}
                      className="py-2.5 bg-rose-600 hover:bg-rose-700 font-semibold rounded-xl text-xs text-white transition-colors"
                    >
                      立即确认删除
                    </button>
                  )}

                  <button
                    onClick={() => setSelectedTaskForDelete(null)}
                    className="py-2.5 mt-1 bg-white border border-slate-200 font-medium rounded-xl text-xs text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* 弹窗3: 提醒通知 */}
        <AnimatePresence>
          {activeAlert && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-55 flex items-center justify-center bg-black/60 p-4 backdrop-blur-md"
            >
              <motion.div
                initial={{ scale: 0.9, y: 30 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 30 }}
                transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                className="w-full max-w-[310px] bg-white rounded-3xl p-5 shadow-2x flex flex-col items-center text-center space-y-4 border border-slate-100"
              >
                {/* 铃声动画 */}
                <div className="relative">
                  <div className="absolute inset-0 bg-[#FF9500]/25 rounded-full animate-ping scale-150 duration-1000"></div>
                  <div className="w-14 h-14 bg-gradient-to-tr from-[#FF9500] to-[#FFCC00] rounded-full flex items-center justify-center text-white shadow-lg animate-bounce duration-500">
                    <BellRing className="w-7 h-7 stroke-[2.5]" />
                  </div>
                </div>

                {/* 提醒详情 */}
                <div className="space-y-1 w-full">
                  <span className="text-[9px] font-extrabold text-amber-500 uppercase tracking-widest bg-amber-50 px-2.5 py-0.5 rounded-full inline-block">
                    ⏱️ 时间提醒
                  </span>
                  <h3 className="text-base font-extrabold text-slate-900 tracking-tight leading-tight pt-1">
                    {activeAlert.task.title}
                  </h3>
                  {activeAlert.task.description && (
                    <p className="text-[11px] text-slate-500 break-all truncate max-h-12 overflow-y-auto px-2 leading-relaxed">
                      {activeAlert.task.description}
                    </p>
                  )}
                </div>

                {/* 日程信息 */}
                <div className="w-full bg-slate-50 rounded-2xl p-3 space-y-1 border border-slate-100 text-left">
                  <div className="flex items-center justify-between text-[11px] font-semibold">
                    <span className="text-slate-400">预设日期</span>
                    <span className="text-slate-700 font-mono">{activeAlert.instanceDate}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-semibold">
                    <span className="text-slate-400">开始时间</span>
                    <span className="text-slate-800 font-mono text-xs font-bold text-slate-900">
                      🔔 {activeAlert.triggerTime}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-semibold">
                    <span className="text-slate-400">提前时间</span>
                    <span className="text-slate-700">
                      {activeAlert.task.remindMinutes === 0 ? '事件开始时' : `${activeAlert.task.remindMinutes}分钟前`}
                    </span>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="w-full flex flex-col gap-1.5 pt-1 font-sans">
                  <button
                    type="button"
                    onClick={() => setActiveAlert(null)}
                    className="w-full py-2.5 bg-slate-950 font-bold hover:bg-black text-white text-[11px] rounded-xl shadow-md transition-all active:scale-98"
                  >
                    我知道了 (已读)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const instanceKey = `${activeAlert.task.id}-${activeAlert.instanceDate}`;
                      setSnoozedAlerts(prev => ({
                        ...prev,
                        [instanceKey]: Date.now() + 5 * 60 * 1000,
                      }));
                      setActiveAlert(null);
                    }}
                    className="w-full py-2 bg-slate-100 font-bold hover:bg-slate-200 text-slate-700 text-[11px] rounded-xl transition-all"
                  >
                    稍后提醒 (5分钟后再次提醒)
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 弹窗4: 滚轮时间选择器 */}
        <AnimatePresence>
          {activeTimePicker && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-55 flex items-end justify-center bg-black/50 backdrop-blur-sm"
              onClick={() => setActiveTimePicker(null)}
            >
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                className="w-full max-w-[400px] bg-white rounded-t-3xl pb-8 p-5 shadow-2xl border-t border-slate-100 flex flex-col space-y-4"
                onClick={e => e.stopPropagation()}
              >
                {/* 头栏 */}
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <button
                    type="button"
                    onClick={() => setActiveTimePicker(null)}
                    className="text-xs font-bold text-slate-400 hover:text-slate-600 px-2 py-1 transition-colors"
                  >
                    取消
                  </button>
                  <span className="text-xs font-extrabold text-slate-900 tracking-tight flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-indigo-500" />
                    <span>设置{activeTimePicker === 'start' ? '开始时间' : '结束时间'}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const formattedTime = `${tempHour}:${tempMinute}`;
                      if (activeTimePicker === 'start') {
                        setStartTime(formattedTime);
                        // 自动将结束时间偏移 +1 小时（防止起始时间晚于结束时间）
                        const [h, m] = formattedTime.split(':').map(Number);
                        const endH = (h + 1) % 24;
                        const endStr = `${endH.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                        setEndTime(endStr);
                      } else {
                        setEndTime(formattedTime);
                      }
                      setActiveTimePicker(null);
                    }}
                    className="text-xs font-extrabold text-indigo-600 hover:text-indigo-700 px-3 py-1 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-all"
                  >
                    确定
                  </button>
                </div>

                {/* 滚轮 — 小时 + 分钟 */}
                <div className="grid grid-cols-2 gap-4 py-2 justify-center relative">

                  {/* 小时滚轮 */}
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 font-sans">小时</span>
                    
                    {/* Up button - wraps around */}
                    <button 
                      type="button"
                      onClick={() => {
                        setTempHour(prev => {
                          const val = (parseInt(prev, 10) - 1 + 24) % 24;
                          return val.toString().padStart(2, '0');
                        });
                      }}
                      className="p-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-500 transition-colors mb-1 active:scale-90 cursor-pointer"
                    >
                      <ChevronUp className="w-5 h-5 stroke-[2.5]" />
                    </button>

                    {/* 数字列表（可点击） */}
                    <div
                      ref={hourContainerRef}
                      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                      className="w-24 h-44 overflow-y-auto flex flex-col items-center relative bg-slate-50/70 rounded-2xl border border-slate-100 py-1 font-mono gap-1 select-none"
                    >
                      {Array.from({ length: 24 }).map((_, idx) => {
                        const valStr = idx.toString().padStart(2, '0');
                        const isSelected = tempHour === valStr;
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setTempHour(valStr)}
                            className={`w-16 py-2.5 text-center text-sm font-bold rounded-xl transition-all shrink-0 cursor-pointer ${
                              isSelected
                                ? 'bg-indigo-600 text-white shadow-md scale-110 ring-2 ring-indigo-100'
                                : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200/40 text-xs'
                            }`}
                          >
                            {valStr}
                          </button>
                        );
                      })}
                    </div>

                    {/* 下按钮（循环） */}
                    <button
                      type="button"
                      onClick={() => {
                        setTempHour((prev) => {
                          const val = (parseInt(prev, 10) + 1) % 24;
                          return val.toString().padStart(2, '0');
                        });
                      }}
                      className="p-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-500 transition-colors mt-1 active:scale-90 cursor-pointer"
                    >
                      <ChevronDown className="w-5 h-5 stroke-[2.5]" />
                    </button>
                  </div>

                  {/* 分钟滚轮 */}
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 font-sans">分钟</span>

                    {/* 上按钮（循环） */}
                    <button
                      type="button"
                      onClick={() => {
                        setTempMinute((prev) => {
                          const val = (parseInt(prev, 10) - 1 + 60) % 60;
                          return val.toString().padStart(2, '0');
                        });
                      }}
                      className="p-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-500 transition-colors mb-1 active:scale-90 cursor-pointer"
                    >
                      <ChevronUp className="w-5 h-5 stroke-[2.5]" />
                    </button>

                    {/* 数字列表（可点击） */}
                    <div
                      ref={minuteContainerRef}
                      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                      className="w-24 h-44 overflow-y-auto flex flex-col items-center relative bg-slate-50/70 rounded-2xl border border-slate-100 py-1 font-mono gap-1 select-none"
                    >
                      {Array.from({ length: 60 }).map((_, idx) => {
                        const valStr = idx.toString().padStart(2, '0');
                        const isSelected = tempMinute === valStr;
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setTempMinute(valStr)}
                            className={`w-16 py-2.5 text-center text-sm font-bold rounded-xl transition-all shrink-0 cursor-pointer ${
                              isSelected
                                ? 'bg-indigo-600 text-white shadow-md scale-110 ring-2 ring-indigo-100'
                                : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200/40 text-xs'
                            }`}
                          >
                            {valStr}
                          </button>
                        );
                      })}
                    </div>

                    {/* 下按钮（循环） */}
                    <button
                      type="button"
                      onClick={() => {
                        setTempMinute((prev) => {
                          const val = (parseInt(prev, 10) + 1) % 60;
                          return val.toString().padStart(2, '0');
                        });
                      }}
                      className="p-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-500 transition-colors mt-1 active:scale-90 cursor-pointer"
                    >
                      <ChevronDown className="w-5 h-5 stroke-[2.5]" />
                    </button>
                  </div>

                </div>

                <p className="text-[10px] text-center text-slate-400 font-medium">
                  💡 支持上下按钮无限循环 (59 ▲ 00 / 00 ▼ 59) 或点击数字直达
                </p>

              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

    </div>
  );
}
