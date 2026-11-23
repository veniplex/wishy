import type de from '../de/common'

const en: Record<keyof typeof de, string> = {
  'rel.today': 'today',
  'rel.tomorrow': 'tomorrow',
  'rel.yesterday': 'yesterday',
  'rel.daysAgo_one': '{count} day ago',
  'rel.daysAgo_other': '{count} days ago',
  'rel.inDays_one': 'in {count} day',
  'rel.inDays_other': 'in {count} days',
  'rel.inMonths_one': 'in {count} month',
  'rel.inMonths_other': 'in {count} months',
  'rel.inYears_one': 'in {count} year',
  'rel.inYears_other': 'in {count} years',

  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',

  'dateToday': '{weekday}, {date}',
  'loading': 'Loading …',
  'saved': 'Saved',
  'save': 'Save',
  'cancel': 'Cancel',
  'done': 'Done',
  'never': 'never',
  'retry': 'Try again',
  'toOverview': 'Back to overview',
  'language': 'Language',
  'you': 'You',
  'ofAmount': 'of {amount}',
}
export default en
