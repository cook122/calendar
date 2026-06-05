/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskCategory = 'work' | 'personal' | 'habit' | 'other';
export type RecurrenceFrequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RecurrenceEndType = 'never' | 'on-date' | 'after-count';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number; // e.g., repeats every N [days, weeks, months, years]
  weekdays?: number[]; // [0, 1, 2, 3, 4, 5, 6] where 0 is Sunday, 1 is Monday... (for weekly)
  endType: RecurrenceEndType;
  endDate?: string; // YYYY-MM-DD
  endCount?: number; // End after N repetitions
  presetType?: 'none' | 'daily' | 'weekly-day' | 'monthly-nth-weekday' | 'monthly-day' | 'yearly-day' | 'weekday' | 'custom';
  monthlyType?: 'day-of-month' | 'nth-weekday';
  nthWeek?: number;
  nthWeekday?: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  date: string; // YYYY-MM-DD base date
  timeEnabled: boolean;
  startTime?: string; // HH:MM
  endTime?: string; // HH:MM
  priority: TaskPriority;
  category: TaskCategory;
  recurrence: RecurrenceRule;
  completedInstances?: string[]; // Array of YYYY-MM-DD strings for completed individual occurrences of a recurring event
  deletedInstances?: string[]; // Array of YYYY-MM-DD strings for deleted individual occurrences of a recurring event
  completed?: boolean; // For non-recurring events
  remindMinutes?: number; // e.g. -1 (none), 0 (on-time), 5, 15, 30, 60 (1 hr), 1440 (1 day)
  ringEnabled?: boolean; // toggle for chiming / sound alerts
  createdAt: string;
}

export interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
}
