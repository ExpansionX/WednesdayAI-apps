import {describe, expect, it} from "vitest"

import type {PhoneNotificationData} from "@mentra/miniapp/background"

import {NOTIFICATION_QUEUE_LIMIT, notificationFromEvent, NotificationQueue, paginate} from "./notifications"
import type {QueuedNotification} from "./notifications"

function event(partial: Partial<PhoneNotificationData> = {}): PhoneNotificationData {
  return {
    notificationId: "n1",
    app: "Messages",
    title: "Alice",
    content: "Lunch?",
    priority: "high",
    timestamp: 1760000000000,
    packageName: "com.google.android.apps.messaging",
    ...partial,
  }
}

function item(id: string): QueuedNotification {
  return {id, app: "Messages", packageName: "com.m", title: `T${id}`, content: `C${id}`}
}

describe("notificationFromEvent", () => {
  it("trims title and content", () => {
    expect(notificationFromEvent(event({title: "  Alice  ", content: " Lunch? "}))).toEqual({
      id: "n1",
      app: "Messages",
      packageName: "com.google.android.apps.messaging",
      title: "Alice",
      content: "Lunch?",
    })
  })

  it("returns null when title and content are empty or whitespace", () => {
    expect(notificationFromEvent(event({title: "", content: ""}))).toBeNull()
    expect(notificationFromEvent(event({title: "   ", content: "\n\t"}))).toBeNull()
  })

  it("returns null when packageName is empty", () => {
    expect(notificationFromEvent(event({packageName: ""}))).toBeNull()
    expect(notificationFromEvent(event({packageName: "  "}))).toBeNull()
  })

  it("tolerates null or non-string fields from the bridge", () => {
    const parsed = notificationFromEvent(event({title: null as unknown as string, content: "Lunch?"}))
    expect(parsed).toEqual({
      id: "n1",
      app: "Messages",
      packageName: "com.google.android.apps.messaging",
      title: "",
      content: "Lunch?",
    })
    expect(notificationFromEvent(event({packageName: null as unknown as string}))).toBeNull()
  })

  it("falls back to packageName:timestamp for the id when notificationId is empty", () => {
    const parsed = notificationFromEvent(event({notificationId: "", timestamp: 1234}))
    expect(parsed?.id).toBe("com.google.android.apps.messaging:1234")
  })

  it("falls back to packageName for the app when app is empty", () => {
    const parsed = notificationFromEvent(event({app: ""}))
    expect(parsed?.app).toBe("com.google.android.apps.messaging")
  })
})

describe("paginate", () => {
  it("returns no pages for empty or whitespace text", () => {
    expect(paginate("", 160)).toEqual([])
    expect(paginate("   \n ", 160)).toEqual([])
  })

  it("collapses whitespace runs into one short page", () => {
    expect(paginate("a  b\n c", 160)).toEqual(["a b c"])
  })

  it("breaks 300 characters of long words at spaces into pages of at most maxChars", () => {
    const text = Array.from({length: 30}, () => "ninechars").join(" ")
    const pages = paginate(text, 160)
    expect(pages).toHaveLength(2)
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(160)
      expect(page).toBe(page.trim())
    }
    expect(pages.join(" ")).toBe(text)
  })

  it("keeps an exact maxChars fit on one page and splits one character over", () => {
    // Two words joining to exactly maxChars stay together; a single word of
    // exactly maxChars stays whole; one more character starts a new page.
    const exact = `${"a".repeat(79)} ${"b".repeat(80)}`
    expect(paginate(exact, 160)).toEqual([exact])
    expect(paginate("c".repeat(160), 160)).toEqual(["c".repeat(160)])
    expect(paginate(`${"a".repeat(79)} ${"b".repeat(81)}`, 160)).toEqual(["a".repeat(79), "b".repeat(81)])
  })

  it("hard-splits a word longer than maxChars", () => {
    const pages = paginate("x".repeat(400), 160)
    expect(pages.map((page) => page.length)).toEqual([160, 160, 80])
  })

  it("keeps surrogate pairs whole when a long word straddles pages", () => {
    const text = "a".repeat(159) + "😀b"
    const pages = paginate(text, 160)
    // The lone-surrogate shape neither page may contain.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const page of pages) {
      expect(page).not.toMatch(lone)
      expect(page.length).toBeLessThanOrEqual(160)
    }
    expect(pages).toEqual(["a".repeat(159), "😀b"])
    expect(pages.join("")).toBe(text)
  })

  it("hard-splits a long no-space CJK run into pages of at most maxChars", () => {
    const text = "字".repeat(400)
    const pages = paginate(text, 160)
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(160)
    expect(pages.join("")).toBe(text)
    expect(pages.map((page) => page.length)).toEqual([160, 160, 80])
  })
})

describe("NotificationQueue", () => {
  it("replaces an existing id in place and keeps the size", () => {
    const queue = new NotificationQueue(3)
    queue.enqueue(item("a"))
    queue.enqueue(item("b"))
    queue.enqueue({...item("a"), title: "A2"})
    expect(queue.size).toBe(2)
    expect(queue.shift()?.id).toBe("a")
    expect(queue.shift()?.title).toBe("Tb")
  })

  it("drops the oldest on the 21st enqueue", () => {
    const queue = new NotificationQueue()
    for (let index = 1; index <= 21; index += 1) queue.enqueue(item(`n${index}`))
    expect(queue.size).toBe(NOTIFICATION_QUEUE_LIMIT)
    expect(queue.shift()?.id).toBe("n2")
  })

  it("unshift puts an item first and removes any same-id entry", () => {
    const queue = new NotificationQueue(3)
    queue.enqueue(item("a"))
    queue.enqueue(item("b"))
    queue.enqueue(item("c"))
    queue.unshift({...item("b"), content: "B2"})
    expect(queue.size).toBe(3)
    expect(queue.shift()?.content).toBe("B2")
    expect(queue.shift()?.id).toBe("a")
    expect(queue.shift()?.id).toBe("c")
  })

  it("unshift at the cap drops the newest waiting item", () => {
    const queue = new NotificationQueue()
    for (let index = 1; index <= NOTIFICATION_QUEUE_LIMIT; index += 1) queue.enqueue(item(`n${index}`))
    queue.unshift(item("fresh"))
    expect(queue.size).toBe(NOTIFICATION_QUEUE_LIMIT)
    expect(queue.shift()?.id).toBe("fresh")
    for (let index = 1; index < NOTIFICATION_QUEUE_LIMIT; index += 1) {
      expect(queue.shift()?.id).toBe(`n${index}`)
    }
    expect(queue.shift()).toBeNull()
  })

  it("remove returns false for unknown ids", () => {
    const queue = new NotificationQueue()
    queue.enqueue(item("a"))
    expect(queue.remove("zz")).toBe(false)
    expect(queue.size).toBe(1)
    expect(queue.remove("a")).toBe(true)
    expect(queue.size).toBe(0)
  })

  it("retain keeps only the matching items", () => {
    const queue = new NotificationQueue()
    queue.enqueue(item("a"))
    queue.enqueue(item("b"))
    queue.enqueue(item("c"))
    queue.retain((entry) => entry.id !== "b")
    expect(queue.size).toBe(2)
    expect(queue.shift()?.id).toBe("a")
    expect(queue.shift()?.id).toBe("c")
  })
})
