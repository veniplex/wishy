// Detail view of ideas, gifts and wishes: the link shown as a clickable anchor (only http/https, domain without "www.").
// No server, no browser; node loads the TypeScript module directly (type stripping).
import { linkInfo } from '../../src/detail-model.ts'

let pass = 0
let failN = 0
const eq = (name, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return void pass++
  failN++
  console.log('FAIL ' + name + ' -> ' + JSON.stringify({ got: a, want: b }))
}

eq('https link', linkInfo('https://www.example.com/p/1?x=2'), { href: 'https://www.example.com/p/1?x=2', host: 'example.com' })
eq('no scheme gets https', linkInfo('shop.example.org/item'), { href: 'https://shop.example.org/item', host: 'shop.example.org' })
eq('whitespace trimmed', linkInfo('  http://a.de  ')?.host, 'a.de')
eq('javascript: is not linked', linkInfo('javascript:alert(1)'), null)
eq('mailto: is not linked', linkInfo('mailto:a@b.de'), null)
eq('empty', linkInfo(''), null)
eq('null', linkInfo(null), null)

console.log(`detail-view: ${pass} passed, ${failN} failed`)
process.exit(failN ? 1 : 0)
