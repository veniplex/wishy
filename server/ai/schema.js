// Minimal JSON schema validator (type, enum, properties/required/additionalProperties, items, anyOf)
// and preparation of the schemas for the providers' structured output.

const typeOk = (v, t) => {
  switch (t) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'integer': return Number.isInteger(v)
    case 'boolean': return typeof v === 'boolean'
    case 'null': return v === null
    case 'array': return Array.isArray(v)
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    default: return false
  }
}

function check(v, s, p, errs) {
  if (s.anyOf) {
    for (const alt of s.anyOf) {
      const e = []
      const out = check(v, alt, p, e)
      if (!e.length) return out
    }
    errs.push(`${p}: matches no allowed variant`)
    return v
  }
  if (s.type) {
    const types = [].concat(s.type)
    if (!types.some((t) => typeOk(v, t))) {
      errs.push(`${p}: expected ${types.join('|')}`)
      return v
    }
  }
  if (s.enum && !s.enum.includes(v)) errs.push(`${p}: value not allowed`)
  if (Array.isArray(v) && s.items) return v.map((x, i) => check(x, s.items, `${p}[${i}]`, errs))
  if (typeOk(v, 'object') && (s.properties || s.required)) {
    const out = {}
    for (const k of s.required || []) if (!(k in v)) errs.push(`${p}.${k}: missing`)
    for (const [k, val] of Object.entries(v)) {
      if (s.properties?.[k]) out[k] = check(val, s.properties[k], `${p}.${k}`, errs)
      else if (s.additionalProperties !== false) out[k] = val // otherwise discard unknown fields
    }
    return out
  }
  return v
}

/** → { ok, errors, value } – value without unknown fields. */
export function validate(value, schema) {
  const errors = []
  const out = check(value, schema, '$', errors)
  return { ok: !errors.length, errors, value: out }
}

const DROP = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'default', 'multipleOf', 'uniqueItems'])

/**
 * Schema for the provider API: remove limit keywords (not supported everywhere – the server enforces the limits
 * afterwards), objects with additionalProperties:false, null types as anyOf.
 */
export function providerSchema(schema) {
  const walk = (s) => {
    if (Array.isArray(s)) return s.map(walk)
    if (!s || typeof s !== 'object') return s
    const o = {}
    for (const [k, v] of Object.entries(s)) {
      if (DROP.has(k)) continue
      o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)])) : walk(v)
    }
    if (Array.isArray(o.type) && o.type.length > 1) {
      const { type, ...rest } = o
      return { ...rest, anyOf: type.map((t) => (t === 'array' || t === 'object' ? walk({ ...s, type: t }) : { type: t })) }
    }
    if (Array.isArray(o.type)) o.type = o.type[0]
    if (o.type === 'object') o.additionalProperties = false
    return o
  }
  return walk(schema)
}

/** Response text → JSON (tolerates code fences and text around the object). */
export function parseJsonText(text) {
  let t = String(text ?? '').trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  if (fence) t = fence[1]
  try {
    return JSON.parse(t)
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1))
    throw new Error('not valid JSON')
  }
}
