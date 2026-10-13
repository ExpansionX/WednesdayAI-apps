/**
 * Phone notification intake for the glasses display.
 *
 * notificationFromEvent maps an SDK phone-notification event to the queued
 * shape the display uses, dropping iOS-style empty posts and filling fallback
 * id/app fields. paginate splits a notification body into display pages of at
 * most maxChars, breaking at spaces and hard-splitting overlong words.
 * NotificationQueue holds the waiting notifications with same-id reposts
 * replacing in place and a bounded size that drops the oldest.
 */

import type {PhoneNotificationData} from "@mentra/miniapp/background"

export interface QueuedNotification {
  id: string
  app: string
  packageName: string
  title: string
  content: string
}

/** Waiting notifications kept before the oldest is dropped. */
export const NOTIFICATION_QUEUE_LIMIT = 20
/** Maximum characters of body text per display page. */
export const NOTIFICATION_PAGE_CHARS = 160

export function notificationFromEvent(data: PhoneNotificationData): QueuedNotification | null {
  const packageName = data.packageName.trim()
  if (!packageName) return null
  const title = data.title.trim()
  const content = data.content.trim()
  if (!title && !content) return null
  return {
    id: data.notificationId.trim() || `${packageName}:${data.timestamp}`,
    app: data.app.trim() || packageName,
    packageName,
    title,
    content,
  }
}

export function paginate(text: string, maxChars: number): string[] {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (!collapsed) return []
  // Hard-split any word longer than a page so every word fits on one line.
  // Splits run on code points, so a surrogate pair never straddles pages;
  // page length stays measured in UTF-16 units.
  const words: string[] = []
  for (const word of collapsed.split(" ")) {
    if (word.length <= maxChars) {
      words.push(word)
      continue
    }
    let chunk = ""
    for (const symbol of Array.from(word)) {
      if (chunk.length + symbol.length > maxChars) {
        if (chunk) words.push(chunk)
        chunk = symbol
      } else {
        chunk += symbol
      }
    }
    if (chunk) words.push(chunk)
  }
  const pages: string[] = []
  let page = ""
  for (const word of words) {
    if (!page) {
      page = word
    } else if (page.length + 1 + word.length <= maxChars) {
      page = `${page} ${word}`
    } else {
      pages.push(page)
      page = word
    }
  }
  if (page) pages.push(page)
  return pages
}

export class NotificationQueue {
  private items: QueuedNotification[] = []
  private readonly limit: number

  constructor(limit: number = NOTIFICATION_QUEUE_LIMIT) {
    this.limit = limit
  }

  get size(): number {
    return this.items.length
  }

  /** The queued entry with this id, if any. */
  find(id: string): QueuedNotification | null {
    return this.items.find((existing) => existing.id === id) ?? null
  }

  /** Append; a same-id repost replaces in place, and overflow drops the oldest. */
  enqueue(item: QueuedNotification): void {
    const index = this.items.findIndex((existing) => existing.id === item.id)
    if (index >= 0) {
      this.items[index] = item
      return
    }
    this.items.push(item)
    if (this.items.length > this.limit) this.items.shift()
  }

  /** Prepend; a same-id entry anywhere in the queue is removed first. */
  unshift(item: QueuedNotification): void {
    this.items = this.items.filter((existing) => existing.id !== item.id)
    this.items.unshift(item)
    if (this.items.length > this.limit) this.items.pop()
  }

  shift(): QueuedNotification | null {
    return this.items.shift() ?? null
  }

  remove(id: string): boolean {
    const index = this.items.findIndex((existing) => existing.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    return true
  }

  retain(keep: (item: QueuedNotification) => boolean): void {
    this.items = this.items.filter(keep)
  }
}
