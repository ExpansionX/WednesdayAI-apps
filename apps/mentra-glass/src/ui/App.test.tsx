// @vitest-environment happy-dom

import {act, cleanup, fireEvent, render, screen} from "@testing-library/react"
import {afterEach, describe, expect, it, vi} from "vitest"

import type {StateSnapshot} from "../shared/channels"
import {App} from "./App"

type Listener = (payload: unknown) => void

function fakeMentra() {
  const sent: Array<{channel: string; payload: unknown}> = []
  const unsubscribed: string[] = []
  const listeners: Record<string, Listener[]> = {}
  const emit = (channel: string, payload: unknown) => {
    for (const listener of listeners[channel] ?? []) listener(payload)
  }
  const listenerCount = () => Object.values(listeners).reduce((total, list) => total + list.length, 0)
  const mentra = {
    send: vi.fn((channel: string, payload: unknown) => {
      sent.push({channel, payload})
    }),
    on: vi.fn((channel: string, listener: Listener) => {
      listeners[channel] = [...(listeners[channel] ?? []), listener]
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((kept) => kept !== listener)
        unsubscribed.push(channel)
      }
    }),
  }
  return {mentra, sent, unsubscribed, emit, listenerCount}
}

function renderApp() {
  const fake = fakeMentra()
  vi.stubGlobal("mentra", fake.mentra)
  const view = render(<App />)
  return {...fake, view}
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    connection: "connected",
    gatewayHost: "wss://g.example.ts.net",
    retryInMs: null,
    triggers: ["hey wednesday"],
    agents: [],
    defaultAgentId: null,
    sessionScope: "per-sender",
    settings: {
      wakeSttMode: "local",
      agentId: null,
      querySttMode: "gateway",
      notificationApps: ["com.example.app"],
    },
    micTestEnabled: false,
    lastError: null,
    seenNotificationApps: [],
    queuedNotifications: 0,
    ...overrides,
  }
}

// Test seam: state pushes must run inside act() at every call site.
function pushState(emit: (channel: string, payload: unknown) => void, snap: StateSnapshot) {
  act(() => emit("state", snap))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("App", () => {
  it("requests the state snapshot on mount", () => {
    const {sent} = renderApp()

    expect(sent).toEqual([{channel: "state:get", payload: {}}])
  })

  it("shows the connecting hint before the first snapshot arrives", () => {
    renderApp()

    expect(screen.getByText("Connecting to the glasses…")).toBeTruthy()
    expect(screen.queryByRole("button", {name: "Pair"})).toBeNull()
  })

  it("renders the gateway status card", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot({lastError: "Gateway unreachable"}))

    expect(screen.getByText("connected")).toBeTruthy()
    expect(screen.getByText("Gateway: wss://g.example.ts.net")).toBeTruthy()
    expect(screen.getByText("Wake words: hey wednesday")).toBeTruthy()
    expect(screen.getByText("Gateway unreachable")).toBeTruthy()
  })

  it("shows the retry countdown and disables pairing while connecting", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot({connection: "connecting", retryInMs: 12_400, gatewayHost: null}))
    fireEvent.change(screen.getByPlaceholderText(/paste the setup code/), {target: {value: "code123"}})

    expect(screen.getByText("connecting — retrying in 12 s")).toBeTruthy()
    expect((screen.getByRole("button", {name: "Scan setup QR"}) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", {name: "Pair"}) as HTMLButtonElement).disabled).toBe(true)

    pushState(emit, snapshot())
    expect((screen.getByRole("button", {name: "Pair"}) as HTMLButtonElement).disabled).toBe(false)
  })

  it("reflects the current settings in the STT mode radios", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot())

    expect((screen.getByRole("radio", {name: "On-device (private; needs offline model)"}) as HTMLInputElement).checked).toBe(
      true,
    )
    expect((screen.getByRole("radio", {name: "Mentra cloud (more accurate)"}) as HTMLInputElement).checked).toBe(false)
    expect(
      (
        screen.getByRole("radio", {
          name: "WednesdayAI gateway (more accurate; needs a transcription provider on the gateway)",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true)
    expect((screen.getByRole("radio", {name: "Mentra (same as wake listening)"}) as HTMLInputElement).checked).toBe(false)
  })

  it("lists seen notification apps with their allowlist state and queue depth", () => {
    const {emit} = renderApp()
    pushState(
      emit,
      snapshot({
        seenNotificationApps: [{packageName: "com.example.app", app: "Example"}],
        queuedNotifications: 2,
      }),
    )

    expect((screen.getByRole("checkbox", {name: /Example/}) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText("Queued: 2")).toBeTruthy()
  })

  it("keeps an enabled app in the menu after it leaves the seen list", () => {
    const {emit, sent} = renderApp()
    pushState(
      emit,
      snapshot({
        seenNotificationApps: [{packageName: "com.example.app", app: "Example"}],
        settings: {
          wakeSttMode: "local",
          agentId: null,
          querySttMode: "gateway",
          notificationApps: ["com.example.app", "com.enabled.app"],
        },
      }),
    )

    // The enabled app is no longer in the capped seen list but must stay
    // tickable so the user can switch it off.
    const unseen = screen.getByRole("checkbox", {name: /com\.enabled\.app/}) as HTMLInputElement
    expect(unseen.checked).toBe(true)
    fireEvent.click(unseen)
    expect(sent).toContainEqual({
      channel: "notifications:allow",
      payload: {packageName: "com.enabled.app", enabled: false},
    })
  })

  it("shows empty-state hints with no notifications, triggers, or queue", () => {
    const {emit} = renderApp()
    pushState(
      emit,
      snapshot({
        triggers: [],
        queuedNotifications: 0,
        settings: {wakeSttMode: "local", agentId: null, querySttMode: "gateway", notificationApps: []},
      }),
    )

    expect(screen.getByText("No notifications seen yet. Apps appear here after your phone shows one.")).toBeTruthy()
    expect(screen.getByText("Wake words: none")).toBeTruthy()
    expect(screen.queryByText(/Queued:/)).toBeNull()
  })

  it("disables the agent select and hints when the gateway session is global", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot({sessionScope: "global"}))

    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText("Gateway uses one global session")).toBeTruthy()
  })

  it("shows the error banner with the pushed message", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot())

    act(() => emit("error", {message: "Pairing failed: code expired"}))

    expect(screen.getByRole("alert").textContent).toContain("Pairing failed: code expired")
  })

  it("dismisses the error banner", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot())
    act(() => emit("error", {message: "Pairing failed: code expired"}))

    fireEvent.click(screen.getByRole("button", {name: "Dismiss"}))

    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps only the five newest mic transcripts, newest first", () => {
    const {emit} = renderApp()
    pushState(emit, snapshot())
    for (let index = 1; index <= 7; index++) {
      act(() => emit("mictest:transcript", {text: String(index), isFinal: index % 2 === 1}))
    }

    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(5)
    expect(items[0].textContent).toBe("final 7")
    expect(items[4].textContent).toBe("final 3")
    expect(screen.queryByText("interim 2")).toBeNull()
  })

  it("sends mictest:set when the mic test is enabled", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot())

    fireEvent.click(screen.getByRole("checkbox", {name: "Show live transcripts"}))

    expect(sent).toContainEqual({channel: "mictest:set", payload: {enabled: true}})
  })

  it("clears transcripts and reports the disable when the mic test is switched off", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot({micTestEnabled: true}))
    act(() => emit("mictest:transcript", {text: "hello", isFinal: true}))

    fireEvent.click(screen.getByRole("checkbox", {name: "Show live transcripts"}))

    expect(screen.queryByRole("listitem")).toBeNull()
    expect(sent).toContainEqual({channel: "mictest:set", payload: {enabled: false}})
  })

  it("sends the trimmed setup code and clears the input on Pair", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot())
    const input = screen.getByPlaceholderText(/paste the setup code/)
    fireEvent.change(input, {target: {value: "  code123  "}})

    fireEvent.click(screen.getByRole("button", {name: "Pair"}))

    expect(sent).toContainEqual({channel: "pair:code", payload: {code: "code123"}})
    expect((input as HTMLTextAreaElement).value).toBe("")
  })

  it("does not pair with a whitespace-only code", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot())
    fireEvent.change(screen.getByPlaceholderText(/paste the setup code/), {target: {value: "   "}})

    fireEvent.click(screen.getByRole("button", {name: "Pair"}))

    expect(sent.filter((call) => call.channel === "pair:code")).toEqual([])
    expect((screen.getByRole("button", {name: "Pair"}) as HTMLButtonElement).disabled).toBe(true)
  })

  it("sends pair:scan from the scan button", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot())

    fireEvent.click(screen.getByRole("button", {name: "Scan setup QR"}))

    expect(sent).toContainEqual({channel: "pair:scan", payload: {}})
  })

  it("sends pair:forget from the unpair button", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot())

    fireEvent.click(screen.getByRole("button", {name: "Unpair"}))

    expect(sent).toContainEqual({channel: "pair:forget", payload: {}})
  })

  it("sends the picked agent id when the agent changes", () => {
    const {emit, sent} = renderApp()
    pushState(emit, snapshot({agents: [{id: "a1", label: "One"}, {id: "a2", label: "Two"}]}))

    fireEvent.change(screen.getByRole("combobox"), {target: {value: "a2"}})

    expect(sent).toContainEqual({channel: "settings:set", payload: {agentId: "a2"}})
  })

  it("sends a null agent id when reverting to the gateway default", () => {
    const {emit, sent} = renderApp()
    pushState(
      emit,
      snapshot({agents: [{id: "a1", label: "One"}], settings: {...snapshot().settings, agentId: "a1"}}),
    )

    fireEvent.change(screen.getByRole("combobox"), {target: {value: ""}})

    expect(sent).toContainEqual({channel: "settings:set", payload: {agentId: null}})
  })

  it("sends the wake STT mode when a wake radio is picked", () => {
    const {emit, sent} = renderApp()
    pushState(
      emit,
      snapshot({settings: {wakeSttMode: "cloud", agentId: null, querySttMode: "gateway", notificationApps: []}}),
    )

    fireEvent.click(screen.getByRole("radio", {name: "On-device (private; needs offline model)"}))
    expect(sent.filter((call) => call.channel === "settings:set")).toEqual([
      {channel: "settings:set", payload: {wakeSttMode: "local"}},
    ])

    pushState(
      emit,
      snapshot({settings: {wakeSttMode: "local", agentId: null, querySttMode: "gateway", notificationApps: []}}),
    )
    fireEvent.click(screen.getByRole("radio", {name: "Mentra cloud (more accurate)"}))
    expect(sent.filter((call) => call.channel === "settings:set")).toEqual([
      {channel: "settings:set", payload: {wakeSttMode: "local"}},
      {channel: "settings:set", payload: {wakeSttMode: "cloud"}},
    ])
  })

  it("sends the query STT mode when a query radio is picked", () => {
    const {emit, sent} = renderApp()
    pushState(
      emit,
      snapshot({settings: {wakeSttMode: "local", agentId: null, querySttMode: "mentra", notificationApps: []}}),
    )

    fireEvent.click(
      screen.getByRole("radio", {name: "WednesdayAI gateway (more accurate; needs a transcription provider on the gateway)"}),
    )
    expect(sent.filter((call) => call.channel === "settings:set")).toEqual([
      {channel: "settings:set", payload: {querySttMode: "gateway"}},
    ])

    pushState(
      emit,
      snapshot({settings: {wakeSttMode: "local", agentId: null, querySttMode: "gateway", notificationApps: []}}),
    )
    fireEvent.click(screen.getByRole("radio", {name: "Mentra (same as wake listening)"}))
    expect(sent.filter((call) => call.channel === "settings:set")).toEqual([
      {channel: "settings:set", payload: {querySttMode: "gateway"}},
      {channel: "settings:set", payload: {querySttMode: "mentra"}},
    ])
  })

  it("sends notifications:allow and waits for the next snapshot to update the list", () => {
    const {emit, sent} = renderApp()
    const seen = [{packageName: "com.example.app", app: "Example"}]
    pushState(
      emit,
      snapshot({seenNotificationApps: seen, settings: {...snapshot().settings, notificationApps: ["com.example.app"]}}),
    )
    const checkbox = screen.getByRole("checkbox", {name: /Example/})

    fireEvent.click(checkbox)

    expect(sent).toContainEqual({
      channel: "notifications:allow",
      payload: {packageName: "com.example.app", enabled: false},
    })
    expect((checkbox as HTMLInputElement).checked).toBe(true)

    pushState(emit, snapshot({seenNotificationApps: seen, settings: {...snapshot().settings, notificationApps: []}}))
    expect((screen.getByRole("checkbox", {name: /Example/}) as HTMLInputElement).checked).toBe(false)
  })

  it("unsubscribes from every channel on unmount", () => {
    const {emit, listenerCount, unsubscribed, view} = renderApp()
    pushState(emit, snapshot())

    view.unmount()

    expect([...unsubscribed].sort()).toEqual(["error", "mictest:transcript", "state"])
    expect(listenerCount()).toBe(0)
  })
})
