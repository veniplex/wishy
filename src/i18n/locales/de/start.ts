/** Start page. de is the source of truth. */
export default {
  'loadFailed': 'Die Daten konnten nicht geladen werden: {error}',

  'occ.chip.planned': 'Geplant',
  'occ.chip.noPeople': 'Keine Personen',
  'occ.chip.missing': 'Geschenk fehlt',
  'occ.chip.covered': '{covered} von {total} versorgt',
  'occ.status.missing': 'Für {names} fehlt noch etwas.',
  'occ.status.open_one': '{count} Geschenk ist noch zu besorgen.',
  'occ.status.open_other': '{count} Geschenke sind noch zu besorgen.',
  'occ.status.done': 'Alles besorgt.',
  'occ.budget': '{mine} von {budget} verplant',
  'occ.noBudget': 'Budget noch nicht festgelegt',

  'welcome.title': 'Willkommen, {name}!',
  'welcome.titleAnon': 'Willkommen!',
  'welcome.text': 'Hier planst du Wünsche, Geschenkideen, gemeinsame Geschenke und behältst die Ausgaben im Blick. Fang mit der ersten Person an.',
  'welcome.create': 'Person anlegen',
  'welcome.demo': 'oder mit Beispieldaten ausprobieren',

  'hello': 'Schön, dass du da bist.',
  'intro.today': 'Heute ist {date}.',
  'intro.gap_zero': 'Bei {name} steht heute etwas an, und noch fehlt das Geschenk.',
  'intro.gap_one': 'Bei {name} steht in {count} Tag etwas an, und noch fehlt das Geschenk.',
  'intro.gap_other': 'Bei {name} steht in {count} Tagen etwas an, und noch fehlt das Geschenk.',
  'intro.calm': 'Es gibt gerade nichts Dringendes.',

  'next.title': 'Als Nächstes',
  'next.toCalendar': 'Zum Kalender',
  'next.empty': 'Lege Personen mit Geburtstag oder einen Anlass wie Weihnachten an.',

  'todo.title': 'Zu erledigen',
  'todo.collect': 'Anteil einsammeln: {title}',
  'todo.sharesOpen_one': '{count} Anteil offen',
  'todo.sharesOpen_other': '{count} Anteile offen',
  'todo.openShares': 'Anteile öffnen',
  'todo.pay': 'Noch bezahlen: {title}',
  'todo.recordPayment': 'Zahlung erfassen',

  'who.title': 'Für wen planst du?',
  'who.all': 'Alle Beschenkten',
  'who.add': 'Hinzufügen',

  'budget.title': 'Budget',
  'budget.spent': 'Ausgaben {year}',
  'budget.of': 'von {amount}',
  'budget.hint': 'Lege in den Einstellungen ein Jahresbudget fest, um den Fortschritt zu sehen.',
} as const
