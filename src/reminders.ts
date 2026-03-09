/**
 * System Reminder Engine
 *
 * Injects contextual guidance into active containers via IPC to counter
 * instruction fade-out during long sessions. Inspired by OpenDev's
 * event-driven reminder architecture (arxiv 2603.05344).
 *
 * Reminder categories:
 *   - task_focus: Re-state original task when agent drifts
 *   - wrap_up: Nudge agent to finish and respond
 *   - inactivity: Wake idle agent to continue working
 *   - error_recovery: Suggest different approach after repeated failures
 */

import { logger } from './logger.js';
import type { GroupQueue } from './group-queue.js';

export interface ReminderRule {
  /** Unique identifier */
  id: string;
  /** When to fire: 'on_idle' | 'after_duration' | 'on_schedule' */
  trigger: 'on_idle' | 'after_duration' | 'on_schedule';
  /** Reminder category tag */
  category: string;
  /** Delay in ms after trigger condition (e.g. 30s after idle) */
  delayMs: number;
  /** Reminder text (may contain {group}, {duration} placeholders) */
  text: string;
  /** Max times this reminder fires per container session (0 = unlimited) */
  maxFires: number;
}

interface ActiveReminder {
  rule: ReminderRule;
  timer: ReturnType<typeof setTimeout>;
  fireCount: number;
}

interface GroupReminderState {
  active: Map<string, ActiveReminder>; // ruleId -> state
  containerStartTime: number;
  originalPrompt?: string;
}

/** Default reminder rules — can be overridden per-group via manifest */
export const DEFAULT_RULES: ReminderRule[] = [
  {
    id: 'idle_wake',
    trigger: 'on_idle',
    category: 'inactivity',
    delayMs: 60_000, // 1 min after going idle
    text: 'You appear to be idle. If you have completed your current task, check for any pending work: review your task list, check for unread messages, or report your status. If you are waiting on something, state what you are waiting for.',
    maxFires: 3,
  },
  {
    id: 'long_session_focus',
    trigger: 'after_duration',
    category: 'task_focus',
    delayMs: 300_000, // 5 min into session
    text: 'You have been running for a while. Stay focused on the original request. If you have completed it, wrap up and send your response. Avoid exploring tangents unless directly relevant.',
    maxFires: 2,
  },
  {
    id: 'long_session_wrap',
    trigger: 'after_duration',
    category: 'wrap_up',
    delayMs: 600_000, // 10 min into session
    text: 'This session has been running for 10+ minutes. Please finish your current action, send any pending replies, and wrap up. Save important findings to memory before the session ends.',
    maxFires: 1,
  },
];

export class ReminderEngine {
  private groups = new Map<string, GroupReminderState>();
  private queue: GroupQueue | null = null;
  private rules: ReminderRule[];

  constructor(rules?: ReminderRule[]) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  /** Link to the group queue for sending reminders */
  setQueue(queue: GroupQueue): void {
    this.queue = queue;
  }

  /** Called when a container starts for a group */
  onContainerStart(groupJid: string, originalPrompt?: string): void {
    this.clearGroup(groupJid);
    const state: GroupReminderState = {
      active: new Map(),
      containerStartTime: Date.now(),
      originalPrompt,
    };
    this.groups.set(groupJid, state);

    // Schedule duration-based reminders
    for (const rule of this.rules) {
      if (rule.trigger === 'after_duration') {
        this.scheduleReminder(groupJid, state, rule);
      }
    }

    logger.debug(
      { groupJid, ruleCount: this.rules.length },
      'Reminder engine started for group',
    );
  }

  /** Called when a container goes idle (finished work, waiting for input) */
  onContainerIdle(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state) return;

    for (const rule of this.rules) {
      if (rule.trigger === 'on_idle') {
        this.scheduleReminder(groupJid, state, rule);
      }
    }
  }

  /** Called when a container receives new work (cancels idle reminders) */
  onContainerActive(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state) return;

    // Cancel idle reminders since agent is working again
    for (const [ruleId, active] of state.active) {
      if (active.rule.trigger === 'on_idle') {
        clearTimeout(active.timer);
        state.active.delete(ruleId);
      }
    }
  }

  /** Called when container stops — clean up all timers */
  onContainerStop(groupJid: string): void {
    this.clearGroup(groupJid);
  }

  private scheduleReminder(
    groupJid: string,
    state: GroupReminderState,
    rule: ReminderRule,
  ): void {
    // Check if already scheduled or exceeded max fires
    const existing = state.active.get(rule.id);
    if (existing) {
      if (rule.maxFires > 0 && existing.fireCount >= rule.maxFires) return;
      clearTimeout(existing.timer); // Reschedule
    }

    const fireCount = existing?.fireCount ?? 0;
    const timer = setTimeout(() => {
      this.fireReminder(groupJid, state, rule, fireCount);
    }, rule.delayMs);

    state.active.set(rule.id, { rule, timer, fireCount });
  }

  private fireReminder(
    groupJid: string,
    state: GroupReminderState,
    rule: ReminderRule,
    previousFires: number,
  ): void {
    if (!this.queue) return;

    const newCount = previousFires + 1;

    // Resolve placeholders
    const durationMin = Math.round(
      (Date.now() - state.containerStartTime) / 60_000,
    );
    let text = rule.text
      .replace(/\{duration\}/g, `${durationMin} minutes`)
      .replace(/\{group\}/g, groupJid);

    if (state.originalPrompt && text.includes('{original_prompt}')) {
      const truncated =
        state.originalPrompt.length > 200
          ? state.originalPrompt.slice(0, 200) + '...'
          : state.originalPrompt;
      text = text.replace(/\{original_prompt\}/g, truncated);
    }

    const sent = this.queue.sendReminder(groupJid, rule.category, text);

    if (sent) {
      logger.info(
        { groupJid, ruleId: rule.id, category: rule.category, fire: newCount },
        'System reminder fired',
      );
    }

    // Update fire count and reschedule if repeatable
    const active = state.active.get(rule.id);
    if (active) {
      active.fireCount = newCount;
      if (rule.maxFires > 0 && newCount >= rule.maxFires) {
        state.active.delete(rule.id);
      } else if (rule.trigger === 'on_idle') {
        // Re-schedule idle reminders with increasing delay
        const nextDelay = rule.delayMs * (newCount + 1);
        const timer = setTimeout(() => {
          this.fireReminder(groupJid, state, rule, newCount);
        }, nextDelay);
        active.timer = timer;
      }
    }
  }

  private clearGroup(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state) return;
    for (const active of state.active.values()) {
      clearTimeout(active.timer);
    }
    this.groups.delete(groupJid);
  }

  /** Clean up everything */
  shutdown(): void {
    for (const groupJid of this.groups.keys()) {
      this.clearGroup(groupJid);
    }
  }
}
