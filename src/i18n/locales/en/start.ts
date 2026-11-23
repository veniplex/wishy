import type de from '../de/start'

const en: Record<keyof typeof de, string> = {
  'loadFailed': "Couldn't load your data: {error}",

  'occ.chip.planned': 'Planned',
  'occ.chip.noPeople': 'No people',
  'occ.chip.missing': 'Gift missing',
  'occ.chip.covered': '{covered} of {total} covered',
  'occ.status.missing': 'Still nothing for {names}.',
  'occ.status.open_one': '{count} gift still to get.',
  'occ.status.open_other': '{count} gifts still to get.',
  'occ.status.done': 'Everything is sorted.',
  'occ.budget': '{mine} of {budget} planned',
  'occ.noBudget': 'No budget set yet',

  'welcome.title': 'Welcome, {name}!',
  'welcome.titleAnon': 'Welcome!',
  'welcome.text': 'This is where you plan wishes, gift ideas and shared gifts, and keep track of what you spend. Start with the first person.',
  'welcome.create': 'Add a person',
  'welcome.demo': 'or try it with sample data',

  'hello': 'Good to see you.',
  'intro.today': 'Today is {date}.',
  'intro.gap_zero': "{name} has something on today, and there's still no gift.",
  'intro.gap_one': "{name} has something coming up in {count} day, and there's still no gift.",
  'intro.gap_other': "{name} has something coming up in {count} days, and there's still no gift.",
  'intro.calm': 'Nothing urgent right now.',

  'next.title': 'Coming up',
  'next.toCalendar': 'Go to calendar',
  'next.empty': 'Add people with a birthday, or an occasion like Christmas.',

  'todo.title': 'To do',
  'todo.collect': 'Collect share: {title}',
  'todo.sharesOpen_one': '{count} share open',
  'todo.sharesOpen_other': '{count} shares open',
  'todo.openShares': 'Open shares',
  'todo.pay': 'Still to pay: {title}',
  'todo.recordPayment': 'Record payment',

  'who.title': 'Who are you planning for?',
  'who.all': 'All recipients',
  'who.add': 'Add',

  'budget.title': 'Budget',
  'budget.spent': 'Spending {year}',
  'budget.of': 'of {amount}',
  'budget.hint': 'Set a yearly budget in settings to see your progress.',
}
export default en
