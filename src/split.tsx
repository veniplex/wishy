import { fmtDate, shares, sum, type Gift } from './lib'
import { useStore } from './store'
import { t, useT } from './i18n'
import { Avatar, Badge, List, Money, Row, type BadgeTone } from './ui'

export type ShareState = 'paid' | 'settled' | 'open' | 'none'

/** Status of a share: only for a paid gift – payer advanced the money, the rest is received (settled) or open. */
export function shareState(g: Gift, personId: number, settled: number): ShareState {
  if (g.payment_status !== 'paid' || !g.payer_id || g.status === 'returned') return 'none'
  if (g.payer_id === personId) return 'paid'
  return settled ? 'settled' : 'open'
}
const STATE: Record<ShareState, { key: 'status.share.paid' | 'status.share.settled' | 'status.share.open'; tone: BadgeTone } | null> = {
  paid: { key: 'status.share.paid', tone: 'accent' },
  settled: { key: 'status.share.settled', tone: 'ok' },
  open: { key: 'status.share.open', tone: 'warn' },
  none: null,
}

/**
 * Cost split of a shared gift per person.
 * `compact`: short inline display for the meta line of a Row; otherwise a dense list of Rows.
 */
export function CostSplit({ g, compact }: { g: Gift; compact?: boolean }) {
  const { person } = useStore()
  useT()
  if (g.givers.length < 2) return null
  const sh = shares(g)
  const price = g.price ?? 0
  const rows = g.givers.map((x) => {
    const p = person(x.person_id)
    return { id: x.person_id, p, name: p?.is_me ? t('common.you') : (p?.name ?? '?'), amount: sh.get(x.person_id) ?? 0, state: shareState(g, x.person_id, x.settled), at: x.settled_at, method: x.settle_method }
  })

  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {rows.map((r) => (
          <span key={r.id} className="whitespace-nowrap">
            {r.name} <Money n={r.amount} className="text-ink" />
            {r.state === 'paid' && ` ${t('status.share.paidShort')}`}
            {r.state === 'open' && <span className="text-warn"> {t('status.share.open')}</span>}
          </span>
        ))}
      </span>
    )
  }

  const undistributed = price - sum(rows.map((r) => r.amount))
  return (
    <div className="space-y-2">
      <List>
        {rows.map((r) => {
          const st = STATE[r.state]
          return (
            <Row
              key={r.id}
              dense
              lead={<Avatar p={r.p} size={32} />}
              title={r.name}
              meta={r.state === 'settled' ? [r.at && t('gifts.split.receivedOn', { date: fmtDate(r.at) }), r.method].filter(Boolean).join(' · ') : price > 0 ? `${Math.round((r.amount / price) * 100)} %` : undefined}
              trailing={<><Money n={r.amount} strong />{st && <Badge tone={st.tone}>{t(st.key)}</Badge>}</>}
            />
          )
        })}
      </List>
      {Math.abs(undistributed) > 0.005 && <div className="meta px-4">{undistributed > 0 ? t('gifts.split.undistributed') : t('gifts.split.overdistributed')}: <Money n={Math.abs(undistributed)} /></div>}
    </div>
  )
}
