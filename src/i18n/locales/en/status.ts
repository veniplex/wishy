import type de from '../de/status'

const en: Record<keyof typeof de, string> = {
  'gift.planned': 'Planned',
  'gift.ordered': 'Ordered',
  'gift.shipped': 'Shipped',
  'gift.delivered': 'Delivered',
  'gift.wrapped': 'Wrapped',
  'gift.given': 'Given',
  'gift.returned': 'Returned',
  'label': 'Status: {status}',
  'aria': 'Status of {title}: {status}',

  'pay.unpaid': 'unpaid',
  'pay.paid': 'paid',
  'pay.open_one': 'open: {count} share · {amount}',
  'pay.open_other': 'open: {count} shares · {amount}',

  'share.paid': 'paid',
  'share.settled': 'Share received',
  'share.open': 'open',
  'share.paidShort': '(paid)',

  'item.planned': 'planned',
}
export default en
