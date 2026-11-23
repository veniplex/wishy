import { randomUUID } from 'node:crypto'
import { db, insert as rawInsert, logGiftEvent, tx, setOccasionParticipants, setGiftLinks, todayStr, ensureUpcoming } from './db.js'

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const inDays = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}
const bday = (age, offsetDays) => {
  const d = inDays(offsetDays)
  d.setFullYear(d.getFullYear() - age)
  return iso(d)
}

/** Fills an (empty) space with sample data. mePersonId = the person linked to the user. */
export function loadDemo(spaceId, mePersonId, locale = 'en') {
  const en = locale === 'en'
  const L = (de, enText) => (en ? enText : de)
  const insert = (table, body) => rawInsert(table, body, spaceId)
  const year = Number(todayStr().slice(0, 4))
  const xmas = `${todayStr() > `${year}-12-24` ? year + 1 : year}-12-24`
  tx(() => {
    const me = mePersonId
    db.prepare('UPDATE persons SET emoji=?, birthday=? WHERE id=?').run('😎', bday(30, 120), me)
    const anna = insert('persons', { name: 'Anna', relationship: L('Partnerin', 'Partner'), relationship_group: 'partner', emoji: '💜', birthday: bday(29, 18), yearly_budget: 300, notes: L('Mag: Keramik, Tee, Bouldern\nSchuhgröße 39, Größe M\nKein Parfum!', 'Likes: ceramics, tea, bouldering\nShoe size 7, size M\nNo perfume!') })
    const mama = insert('persons', { name: L('Mama', 'Mum'), relationship: L('Mutter', 'Mother'), relationship_group: 'family', emoji: '🌷', birthday: bday(58, 75), yearly_budget: 120 })
    const papa = insert('persons', { name: L('Papa', 'Dad'), relationship: L('Vater', 'Father'), relationship_group: 'family', emoji: '🔧', birthday: bday(61, 200), yearly_budget: 120 })
    const tom = insert('persons', { name: 'Tom', relationship: L('Freund', 'Friend'), relationship_group: 'friends', emoji: '🎸', birthday: bday(31, 40), yearly_budget: 50 })

    // A colleague who is left out of Christmas: Christmas is open to everyone, minus the left out ones
    const lena = insert('persons', { name: 'Lena', relationship: L('Kollegin', 'Colleague'), relationship_group: 'work', emoji: '☕', birthday: bday(34, 260) })
    const christmas = insert('occasions', { name: L('Weihnachten', 'Christmas'), type: 'christmas', date: xmas, recurring: 1, series_id: randomUUID(), budget: 400, audience: 'all' })
    setOccasionParticipants(christmas, 'all', { excludedIds: [lena] })
    const lastXmas = insert('occasions', { name: L('Weihnachten', 'Christmas'), type: 'christmas', date: `${Number(xmas.slice(0, 4)) - 1}-12-24`, recurring: 1, series_id: db.prepare('SELECT series_id FROM occasions WHERE id=?').get(christmas).series_id, budget: 350 })
    setOccasionParticipants(lastXmas, 'selected', { personIds: [anna, mama, papa] })
    // A custom occasion type, to show that types are configurable per space (Settings > Space)
    db.prepare('INSERT OR IGNORE INTO occasion_types (space_id,key,name,icon,default_month_day,default_recurring,sort) VALUES (?,?,?,?,?,?,?)').run(spaceId, 'custom_demo', L('Sommerfest', 'Summer party'), 'party-popper', '07-15', 1, 100)
    ensureUpcoming(spaceId)
    const annaBday = db.prepare("SELECT id FROM occasions WHERE type='birthday' AND person_id=? AND space_id=?").get(anna, spaceId).id

    const teekanne = insert('items', { person_id: anna, mentioned: 1, title: L('Gusseiserne Teekanne', 'Cast-iron teapot'), price: 65, priority: 3, source: L('Hat sie im Teeladen erwähnt', 'Mentioned it at the tea shop') })
    insert('items', { person_id: anna, title: L('Töpferkurs am Wochenende', 'Weekend pottery class'), price: 140, priority: 2, source: L('Plakat im Café gesehen', 'Saw a poster in the café') })
    insert('items', { person_id: anna, title: L('Kletterschuhe (neues Modell)', 'Climbing shoes (new model)'), price: 120, priority: 1 })
    insert('items', { person_id: mama, mentioned: 1, title: L('Hochbeet für den Balkon', 'Raised bed for the balcony'), price: 90, priority: 3 })
    insert('items', { person_id: papa, title: L('Akkuschrauber-Bitset', 'Cordless screwdriver bit set'), price: 35, priority: 2, source: L('Sein altes ist unvollständig', 'His old one is incomplete') })
    insert('items', { person_id: tom, title: L('Vinyl: Lieblingsalbum als Reissue', 'Vinyl: favourite album reissue'), price: 32, priority: 2 })
    // An idea bound to an occasion (turning it into a gift inherits person and occasion)
    insert('items', { person_id: mama, occasion_id: christmas, title: L('Kuscheldecke aus Merinowolle', 'Merino wool blanket'), price: 75, priority: 2, source: L('Hat über kalte Füße geklagt', 'Complained about cold feet') })

    const uid = db.prepare('SELECT linked_user_id FROM persons WHERE id=?').get(me)?.linked_user_id ?? null
    const day = (n) => iso(inDays(n))
    const gift = (g, events = []) => {
      const id = insert('gifts', g)
      setGiftLinks(id, g)
      logGiftEvent(id, uid, 'created', { title: g.title })
      for (const [type, data] of events) logGiftEvent(id, uid, type, data)
      return id
    }
    // Shipped, with tracking, paid by you (your own share is settled automatically)
    gift(
      {
        title: L('Gusseiserne Teekanne', 'Cast-iron teapot'), occasion_id: annaBday, item_id: teekanne, price: 65, status: 'shipped', shop: L('Teeladen', 'Tea shop'),
        order_number: 'TL-48213', ordered_at: day(-4), carrier: 'DHL', tracking_number: '00340434161094042557',
        tracking_url: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094042557',
        expected_at: day(3), payment_status: 'paid', paid_at: day(-4), payment_method: 'PayPal',
        payer_id: me, recipient_ids: [anna], givers: [{ person_id: me }],
      },
      [['status', { from: 'planned', to: 'ordered' }], ['paid', { by: me, amount: 65, method: 'PayPal' }], ['status', { from: 'ordered', to: 'shipped' }]],
    )
    gift({ title: L('Wellness-Wochenende', 'Spa weekend'), occasion_id: christmas, price: 320, status: 'planned', recipient_ids: [mama, papa], givers: [{ person_id: me }, { person_id: anna }] })
    // Paid by you: Anna and Mum still owe 30 each
    gift(
      {
        title: L('Konzerttickets', 'Concert tickets'), occasion_id: christmas, price: 90, status: 'delivered', delivered_at: day(-2), ordered_at: day(-9),
        payment_status: 'paid', paid_at: day(-9), payment_method: L('Karte', 'Card'), payer_id: me, recipient_ids: [tom],
        givers: [{ person_id: me, amount: 30 }, { person_id: anna, amount: 30 }, { person_id: mama, amount: 30 }],
      },
      [['status', { from: 'planned', to: 'ordered' }], ['paid', { by: me, amount: 90, method: L('Karte', 'Card') }], ['status', { from: 'ordered', to: 'delivered' }]],
    )
    // Fully settled
    gift(
      {
        title: L('Kaffeemühle', 'Coffee grinder'), occasion_id: lastXmas, price: 180, status: 'given', given_at: `${Number(xmas.slice(0, 4)) - 1}-12-24`,
        payment_status: 'paid', payment_method: L('Überweisung', 'Bank transfer'), payer_id: anna, recipient_ids: [mama, papa],
        givers: [{ person_id: me, settled: 1, settled_at: day(-300), settle_method: L('Bar', 'Cash') }, { person_id: anna }],
      },
      [['paid', { by: anna, amount: 180, method: L('Überweisung', 'Bank transfer') }], ['share_settled', { person_id: me, amount: 90, method: L('Bar', 'Cash') }], ['status', { from: 'wrapped', to: 'given' }]],
    )
    gift({ title: L('Wollschal', 'Wool scarf'), occasion_id: lastXmas, price: 70, status: 'given', payment_status: 'paid', payer_id: me, recipient_ids: [anna], givers: [{ person_id: me }] })
  })
}
