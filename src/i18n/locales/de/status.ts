/** Status of gifts, payments and shares. de is the source of truth. */
export default {
  'gift.planned': 'Geplant',
  'gift.ordered': 'Bestellt',
  'gift.shipped': 'Versandt',
  'gift.delivered': 'Geliefert',
  'gift.wrapped': 'Verpackt',
  'gift.given': 'Verschenkt',
  'gift.returned': 'Zurückgegeben',
  'label': 'Status: {status}',
  'aria': 'Status von {title}: {status}',

  'pay.unpaid': 'unbezahlt',
  'pay.paid': 'bezahlt',
  'pay.open_one': 'offen: {count} Anteil · {amount}',
  'pay.open_other': 'offen: {count} Anteile · {amount}',

  'share.paid': 'hat bezahlt',
  'share.settled': 'Anteil erhalten',
  'share.open': 'offen',
  'share.paidShort': '(bezahlt)',

  'item.planned': 'verplant',
} as const
