/**
 * Hardware/browser Back closes the topmost overlay (dialog, bottom sheet) instead of leaving the page.
 *
 * Every open layer owns one history entry (same URL, state `{ ...history.state, __layer: id }`, so the router's own state stays intact).
 * - Back pressed: the entry is gone already; the top layer is asked to close (its `onClose` may refuse, e.g. a "discard changes?"
 *   confirmation: the entry is then re-created, see `reconcile`).
 * - Closed by the UI: the entry is removed with history.back(), unless a route change already pushed another entry on top of it
 *   (then it stays as a stale entry that is skipped in the direction of travel when Back or Forward reaches it).
 * - Nested layers: only the top layer reacts; layers without entry get theirs when they become the top.
 */
import { useEffect, useRef } from 'react'

interface Layer { id: string; close: () => void; entry: boolean }
const stack: Layer[] = []
let selfPops = 0
let guard = 0
let seq = 0

const ours = (id: unknown) => typeof id === 'string' && id.startsWith('layer-')

// The router numbers its entries (`state.idx`); a layer's entry shares the number of the page below it. `here` is the number of the
// entry we are on, so a popstate can tell Back from Forward.
const currentIdx = () => Number((history.state as { idx?: number } | null)?.idx ?? 0)
let here = currentIdx()
const push = history.pushState.bind(history)
history.pushState = (...args) => { push(...args); here = currentIdx() }

/** A closed layer's entry: go on in the direction of travel. Forward may have nothing behind it (the layer was closed with Back): return then. */
function skipStale(from: number) {
  if (from > currentIdx()) { history.back(); return }
  const mark = (history.state as { __layer?: string }).__layer
  history.forward()
  window.setTimeout(() => {
    if ((history.state as { __layer?: string } | null)?.__layer === mark) { here = currentIdx() + 1; history.back() }
  }, 200)
}

/** The top layer needs an entry; nothing is pushed while an own history.back() is still on its way */
function reconcile() {
  if (selfPops > 0) return
  const top = stack[stack.length - 1]
  if (top && !top.entry) {
    history.pushState({ ...(history.state ?? {}), __layer: top.id }, '')
    top.entry = true
  }
}

function onPop() {
  const from = here
  here = currentIdx()
  if (selfPops > 0) {
    selfPops--
    if (!selfPops) window.clearTimeout(guard)
    reconcile()
    return
  }
  const st = history.state as { __layer?: string } | null
  const top = stack[stack.length - 1]
  const mark = st?.__layer
  if (ours(mark) && !stack.some((l) => l.id === mark)) { skipStale(from); return }
  if (!top) return
  if (mark === top.id) return // forward onto the top layer's own entry
  top.entry = false
  top.close()
  window.setTimeout(reconcile, 80) // the layer refused to close (confirmation): it gets a new entry
}

window.addEventListener('popstate', onPop)

function register(close: () => void): () => void {
  const layer: Layer = { id: `layer-${++seq}`, close, entry: false }
  stack.push(layer)
  reconcile()
  return () => {
    const i = stack.indexOf(layer)
    if (i < 0) return
    stack.splice(i, 1)
    const st = history.state as { __layer?: string } | null
    if (layer.entry && st?.__layer === layer.id) {
      selfPops++
      window.clearTimeout(guard)
      guard = window.setTimeout(() => { selfPops = 0; reconcile() }, 600) // safety: back() without popstate
      history.back()
    } else reconcile()
  }
}

/** While `active`, Back (hardware/browser) calls `onClose` for the topmost layer */
export function useBackLayer(onClose: () => void, active = true) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!active) return
    let off: (() => void) | null = null
    // Deferred: React StrictMode runs effect -> cleanup -> effect in development, that must not touch the history twice
    const timer = window.setTimeout(() => { off = register(() => ref.current()) }, 0)
    return () => { window.clearTimeout(timer); off?.() }
  }, [active])
}
