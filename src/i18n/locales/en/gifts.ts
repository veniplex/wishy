import type de from '../de/gifts'

const en: Record<keyof typeof de, string> = {
  'title': 'Gifts',
  'sub_one': '{count} gift · {total}',
  'sub_other': '{count} gifts · {total}',
  'plan': 'Plan a gift',
  'searchAria': 'Search gifts',
  'searchPlaceholder': 'Search …',
  'range.aria': 'Time range',
  'range.upcoming': 'Current & upcoming',
  'range.all': 'All',
  'status.aria': 'Status',
  'status.all': 'All statuses',
  'pay.aria': 'Payment',
  'pay.all': 'All payments',
  'pay.unpaid': 'Unpaid',
  'pay.open': 'Shares open',
  'pay.paid': 'Paid',
  'empty': 'No gifts found.',

  'openLink': 'Open link',
  'details.hide': 'Hide details',
  'details.show': 'Show details',
  'for': 'for {names}',
  'noRecipient': 'No recipient yet',
  'alsoFor': 'also for {names}',
  'view.label': 'Grouping',
  'view.person': 'By person',
  'view.date': 'By date',

  'split.undistributed': 'Not allocated',
  'split.overdistributed': 'Over-allocated',
  'split.receivedOn': 'received on {date}',
}
export default en
