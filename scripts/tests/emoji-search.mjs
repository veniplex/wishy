// Emoji picker data and search (src/emoji-data.ts): well-formed data, language preference with fallback, diacritics, multiple words.
// No server, no browser; node loads the TypeScript module directly (type stripping).
import { CATEGORIES, fold, searchEmoji } from '../../src/emoji-data.ts'

let pass = 0
let failN = 0
const t = (name, cond, extra) => {
  if (cond) return void pass++
  failN++
  console.log('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''))
}
const first = (q, lang) => searchEmoji(q, lang)[0]?.e
const has = (q, lang, e) => searchEmoji(q, lang).some((x) => x.e === e)

const all = CATEGORIES.flatMap((c) => c.items)
t('eight categories', CATEGORIES.length === 8, CATEGORIES.map((c) => c.id))
t('a few hundred emoji', all.length > 500, all.length)
t('no duplicates', new Set(all.map((x) => x.e)).size === all.length, all.map((x) => x.e).filter((e, i, a) => a.indexOf(e) !== i))
t('every entry has names in both languages', all.every((x) => x.e && x.name.en && x.name.de && x.en && x.de), all.find((x) => !(x.e && x.name.en && x.name.de)))
t('every emoji is a single grapheme', all.every((x) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(x.e)].length === 1), all.find((x) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(x.e)].length !== 1))
t('no flags (regional indicators)', all.every((x) => !/[\u{1F1E6}-\u{1F1FF}]/u.test(x.e)))

t('fold: umlauts, sharp s and case', fold('Größe ÄÖÜ') === 'grosse aou', fold('Größe ÄÖÜ'))
t('empty query -> nothing', searchEmoji('  ', 'de').length === 0)
t('de name', first('Geburtstagskuchen', 'de') === '🎂', first('Geburtstagskuchen', 'de'))
t('en name', first('birthday cake', 'en') === '🎂', first('birthday cake', 'en'))
t('de query in the en UI falls back to the other language', has('geschenk', 'en', '🎁'))
t('en query in the de UI falls back to the other language', has('present', 'de', '🎁'))
t('umlaut-free typing finds umlaut names', has('buero', 'de', '🏢') || has('burogebaude', 'de', '🏢') || has('buro', 'de', '🏢'))
t('prefix typing', has('gebu', 'de', '🎂'))
t('keywords are searched', has('torte', 'de', '🎂') && has('party', 'en', '🎉'))
t('several words must all match', has('red heart', 'en', '❤️') && !has('red heart xyz', 'en', '❤️'))
t('own language comes first', first('hund', 'de') === '🐶' || searchEmoji('hund', 'de').slice(0, 3).some((x) => x.e === '🐕'), searchEmoji('hund', 'de').slice(0, 3).map((x) => x.e))
t('no match -> empty', searchEmoji('qqqqzzzz', 'en').length === 0)

console.log(`emoji-search: ${pass} passed, ${failN} failed`)
process.exit(failN ? 1 : 0)
