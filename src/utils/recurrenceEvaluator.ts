/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Task } from '../types';

/**
 * Parses YYYY-MM-DD into a safe local Date object (setting the hour to 12:00:00 to avoid DST/timezone issues)
 */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

/**
 * Formats a Date object as YYYY-MM-DD in local time
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Gets the start of the week (Sunday) for a given date
 */
export function getStartOfWeek(date: Date): Date {
  const result = new Date(date);
  const day = result.getDay();
  result.setDate(result.getDate() - day);
  return result;
}

/**
 * Evaluates whether a given task occurs on a specific target date (YYYY-MM-DD).
 * Also returns whether that specific instance is completed.
 */
export function evaluateTaskOccurrence(task: Task, targetDateStr: string): { isOccurrence: boolean; isCompleted: boolean } {
  const baseDateStr = task.date;
  
  // Tasks cannot occur before their base creation date
  if (targetDateStr < baseDateStr) {
    return { isOccurrence: false, isCompleted: false };
  }

  // Ensure it's not deleted as an exception instance
  if (task.deletedInstances && task.deletedInstances.includes(targetDateStr)) {
    return { isOccurrence: false, isCompleted: false };
  }

  const { frequency, interval = 1, weekdays, endType, endDate, endCount } = task.recurrence;

  // Single occurrence task
  if (frequency === 'none') {
    const isOccur = targetDateStr === baseDateStr;
    const isComp = isOccur ? !!task.completed : false;
    return { isOccurrence: isOccur, isCompleted: isComp };
  }

  // Check end date constraint first
  if (endType === 'on-date' && endDate && targetDateStr > endDate) {
    return { isOccurrence: false, isCompleted: false };
  }

  // To handle occurrences properly and support 'after-count',
  // we can generate all occurrences sequentially from baseDateStr until targetDateStr.
  // This is highly robust and avoids complex closed-form modulo math errors, especially for after-count and intervals.
  const occurrences = generateOccurrences(task, targetDateStr);
  const isOccur = occurrences.includes(targetDateStr);
  
  if (isOccur) {
    const isComp = !!task.completedInstances?.includes(targetDateStr);
    return { isOccurrence: true, isCompleted: isComp };
  }

  return { isOccurrence: false, isCompleted: false };
}

/**
 * Generates all occurrence dates (YYYY-MM-DD strings) for a task starting from its base date
 * up to a maxDate limit, while respecting the recurrence rules and end constraints.
 */
export function generateOccurrences(task: Task, maxDateStr: string): string[] {
  const baseDateStr = task.date;
  if (maxDateStr < baseDateStr) return [];

  const { frequency, interval = 1, weekdays, endType, endDate, endCount } = task.recurrence;

  if (frequency === 'none') {
    return [baseDateStr];
  }

  const limitDateStr = (endType === 'on-date' && endDate && endDate < maxDateStr) ? endDate : maxDateStr;
  const targetEndCount = (endType === 'after-count' && endCount) ? endCount : Infinity;

  const occurrences: string[] = [];
  const baseDate = parseLocalDate(baseDateStr);
  const limitDate = parseLocalDate(limitDateStr);

  let current = new Date(baseDate);
  const maxIterations = 3000; // Defensive ceiling to avoid infinite loops
  let iter = 0;

  if (frequency === 'daily') {
    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      const currentStr = formatLocalDate(current);
      occurrences.push(currentStr);
      
      // Advance by interval days
      current.setDate(current.getDate() + interval);
    }
  } else if (frequency === 'weekly') {
    // Start at week of baseDate
    const baseWeekStart = getStartOfWeek(baseDate);
    
    // We step week-by-week
    // Inside each week, we check for target weekdays
    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      const currentWeekStart = getStartOfWeek(current);
      const weekDiff = Math.round((currentWeekStart.getTime() - baseWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
      
      if (weekDiff % interval === 0) {
        // This is a matching week. Look at weekdays
        if (weekdays && weekdays.length > 0) {
          // Sort weekdays to ensure sequential order inside the week
          const sortedWeekdays = [...weekdays].sort((a, b) => a - b);
          for (const wd of sortedWeekdays) {
            // Find the specific date for this weekday in the current week
            const dayOfThisWeek = new Date(currentWeekStart);
            dayOfThisWeek.setDate(dayOfThisWeek.getDate() + wd);
            
            // Check if this date falls within our bounds
            if (dayOfThisWeek >= baseDate && dayOfThisWeek <= limitDate) {
              const dateStr = formatLocalDate(dayOfThisWeek);
              if (!occurrences.includes(dateStr)) {
                occurrences.push(dateStr);
              }
              if (occurrences.length >= targetEndCount) break;
            }
          }
        } else {
          // No weekdays specified; falls on the same weekday as baseDate
          if (current >= baseDate) {
            const dateStr = formatLocalDate(current);
            occurrences.push(dateStr);
          }
        }
      }
      
      // Move current to next Sunday (start of next week) to step safely
      current = new Date(currentWeekStart);
      current.setDate(current.getDate() + 7);
    }
  } else if (frequency === 'monthly') {
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
          if (nthWeek === -1) {
            // Last nthWeekday of the month
            const d = new Date(year, month + 1, 0, 12, 0, 0); // Last day of month
            while (d.getDay() !== nthWeekday) {
              d.setDate(d.getDate() - 1);
            }
            candidate = d;
          } else {
            // Nth nthWeekday of the month
            const d = new Date(year, month, 1, 12, 0, 0); // 1st day of month
            while (d.getDay() !== nthWeekday) {
              d.setDate(d.getDate() + 1);
            }
            // Add (nthWeek - 1) * 7 days
            d.setDate(d.getDate() + (nthWeek - 1) * 7);
            
            // Check if still in same month
            if (d.getMonth() === month) {
              candidate = d;
            }
          }
        } else {
          // Standard day of month
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
      
      // Advance to next month
      monthsElapsed += 1;
      current = new Date(baseDate.getFullYear(), baseDate.getMonth() + monthsElapsed, 1, 12, 0, 0);
    }
  } else if (frequency === 'yearly') {
    const baseMonth = baseDate.getMonth();
    const baseDay = baseDate.getDate();
    let yearsElapsed = 0;
    
    while (current <= limitDate && occurrences.length < targetEndCount && iter < maxIterations) {
      iter++;
      if (yearsElapsed % interval === 0) {
        const year = current.getFullYear();
        const maxDaysInMonth = new Date(year, baseMonth + 1, 0, 12, 0, 0).getDate();
        const targetDay = Math.min(baseDay, maxDaysInMonth);
        
        const candidate = new Date(year, baseMonth, targetDay, 12, 0, 0);
        if (candidate >= baseDate && candidate <= limitDate) {
          const dateStr = formatLocalDate(candidate);
          occurrences.push(dateStr);
        }
      }
      
      yearsElapsed += 1;
      current = new Date(baseDate.getFullYear() + yearsElapsed, baseDate.getMonth(), 1, 12, 0, 0);
    }
  }

  // Filter out any instances that are deleted
  const activeOccurrences = occurrences.filter(d => !(task.deletedInstances && task.deletedInstances.includes(d)));
  
  // Cut count to targetEndCount again in case of weekly duplicates
  return activeOccurrences.slice(0, targetEndCount);
}
