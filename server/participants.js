// Who takes part in an occasion ("effective participants") - the single place that applies the audience rules.
//  - audience 'selected': the persons with an occasion_persons row (excluded=0).
//  - audience 'all': every active person of the space except the left out ones and the viewer's own person(s) (surprise protection).
//    (In a personal space the own person is no "hidden" person but is still not planned for.) A past occasion only counts persons who already existed on its date or who have a gift in it, so a person added today does not
//    show up as "nothing planned" in last year's Christmas.
//  - Left out persons (excluded=1) are reported separately; the viewer never sees their own person there.

/**
 * `rows`: occasion_persons of the occasion; `persons`: all persons of the space; `hidden`: person ids hidden from the viewer; `own`: the viewer's own person ids;
 * `giftPersons`: ids of the recipients of gifts planned in this occasion; returns { person_ids, excluded_ids }.
 */
export function occasionParticipants(o, { rows, persons, hidden, own, today, giftPersons }) {
  const left = new Set(rows.filter((r) => r.excluded).map((r) => r.person_id))
  const excluded_ids = [...left].filter((id) => !hidden.has(id))
  if (o.audience !== 'all') return { person_ids: rows.filter((r) => !r.excluded).map((r) => r.person_id), excluded_ids }
  const past = o.date < today
  const person_ids = persons
    .filter((p) => !p.archived && !hidden.has(p.id) && !own.has(p.id) && !left.has(p.id))
    .filter((p) => !past || String(p.created_at).slice(0, 10) <= o.date || giftPersons?.has(p.id))
    .map((p) => p.id)
  return { person_ids, excluded_ids }
}
