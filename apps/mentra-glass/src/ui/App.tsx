/**
 * Phone UI menu for the WednesdayAI glasses assistant.
 *
 * Talks to the background JSContext over the typed channel registry in
 * src/shared/channels.ts: it sends intent broadcasts (pair, settings, mic
 * test) and renders the "state" snapshot the background pushes on every
 * change. All hardware and gateway access lives background-side.
 */

import {useEffect, useState} from "react"

import type {StateSnapshot} from "../shared/channels"

const TRANSCRIPT_LIMIT = 5

interface TranscriptItem {
  text: string
  isFinal: boolean
}

export function App() {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([])

  useEffect(() => {
    const unsubs = [
      mentra.on("state", (next) => setSnapshot(next)),
      mentra.on("error", ({message}) => setError(message)),
      mentra.on("mictest:transcript", (item) => {
        setTranscripts((prev) => [item, ...prev].slice(0, TRANSCRIPT_LIMIT))
      }),
    ]
    mentra.send("state:get", {})
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])

  if (!snapshot) {
    return (
      <div className="app">
        <h1>WednesdayAI</h1>
        <p className="hint">Connecting to the glasses…</p>
      </div>
    )
  }

  const pairDisabled = snapshot.connection === "connecting"

  return (
    <div className="app">
      <h1>WednesdayAI</h1>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="card">
        <h2>Status</h2>
        <p>
          {snapshot.connection}
          {snapshot.retryInMs != null ? ` — retrying in ${Math.max(1, Math.round(snapshot.retryInMs / 1000))} s` : ""}
        </p>
        {snapshot.gatewayHost && <p className="hint">Gateway: {snapshot.gatewayHost}</p>}
        <p className="hint">Wake words: {snapshot.triggers.length ? snapshot.triggers.join(", ") : "none"}</p>
        {snapshot.lastError && <p className="warning">{snapshot.lastError}</p>}
      </section>

      <section className="card">
        <h2>Pairing</h2>
        <div className="row">
          <button type="button" disabled={pairDisabled} onClick={() => mentra.send("pair:scan", {})}>
            Scan setup QR
          </button>
          <button type="button" className="danger" onClick={() => mentra.send("pair:forget", {})}>
            Unpair
          </button>
        </div>
        <textarea
          className="setup-code"
          placeholder="Or paste the setup code from: wednesdayai qr --client openclaw-mentra-node"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button
          type="button"
          disabled={pairDisabled || !code.trim()}
          onClick={() => {
            mentra.send("pair:code", {code: code.trim()})
            setCode("")
          }}
        >
          Pair
        </button>
      </section>

      <section className="card">
        <h2>Agent</h2>
        <select
          value={snapshot.settings.agentId ?? ""}
          disabled={snapshot.sessionScope === "global"}
          onChange={(event) =>
            mentra.send("settings:set", {
              agentId: event.target.value === "" ? null : event.target.value,
            })
          }
        >
          <option value="">Gateway default</option>
          {snapshot.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>
        {snapshot.sessionScope === "global" && <p className="hint">Gateway uses one global session</p>}
      </section>

      <section className="card">
        <h2>Wake listening</h2>
        <label className="row">
          <input
            type="radio"
            name="wake-stt-mode"
            checked={snapshot.settings.wakeSttMode === "local"}
            onChange={() => mentra.send("settings:set", {wakeSttMode: "local"})}
          />
          On-device (private; needs offline model)
        </label>
        <label className="row">
          <input
            type="radio"
            name="wake-stt-mode"
            checked={snapshot.settings.wakeSttMode === "cloud"}
            onChange={() => mentra.send("settings:set", {wakeSttMode: "cloud"})}
          />
          Mentra cloud (more accurate)
        </label>
        <p className="hint">On-device mode needs the offline speech model: Mentra App → Settings → Transcription.</p>
      </section>

      <section className="card">
        <h2>Question transcription</h2>
        <label className="row">
          <input
            type="radio"
            name="query-stt-mode"
            checked={snapshot.settings.querySttMode === "gateway"}
            onChange={() => mentra.send("settings:set", {querySttMode: "gateway"})}
          />
          WednesdayAI gateway (more accurate; needs a transcription provider on the gateway)
        </label>
        <label className="row">
          <input
            type="radio"
            name="query-stt-mode"
            checked={snapshot.settings.querySttMode === "mentra"}
            onChange={() => mentra.send("settings:set", {querySttMode: "mentra"})}
          />
          Mentra (same as wake listening)
        </label>
        <p className="hint">If the gateway cannot transcribe, Mentra&apos;s transcript is used.</p>
      </section>

      <section className="card">
        <h2>Glasses notifications</h2>
        <p className="hint">Android only. On iOS the glasses firmware shows notifications itself.</p>
        {snapshot.seenNotificationApps.length === 0 ? (
          <p className="hint">No notifications seen yet. Apps appear here after your phone shows one.</p>
        ) : (
          snapshot.seenNotificationApps.map((app) => (
            <label key={app.packageName} className="row">
              <input
                type="checkbox"
                checked={snapshot.settings.notificationApps.includes(app.packageName)}
                onChange={(event) => {
                  mentra.send("notifications:allow", {
                    packageName: app.packageName,
                    enabled: event.target.checked,
                  })
                }}
              />
              {app.app} <span className="hint">{app.packageName}</span>
            </label>
          ))
        )}
        {snapshot.queuedNotifications > 0 && <p className="hint">Queued: {snapshot.queuedNotifications}</p>}
        <p className="hint">Stop Mentra Notify in the Mentra App so messages are not shown twice.</p>
      </section>

      <section className="card">
        <h2>Mic test</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={snapshot.micTestEnabled}
            onChange={(event) => {
              if (!event.target.checked) setTranscripts([])
              mentra.send("mictest:set", {enabled: event.target.checked})
            }}
          />
          Show live transcripts
        </label>
        <ul className="transcripts">
          {transcripts.map((item, index) => (
            <li key={`${index}-${item.text}`}>
              <span className="hint">{item.isFinal ? "final" : "interim"}</span> {item.text}
            </li>
          ))}
        </ul>
      </section>

      <p className="hint">Stop Mentra AI in the Mentra App so only one assistant answers.</p>
    </div>
  )
}
