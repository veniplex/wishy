import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { api } from './api'
import { t, useT, type TKey } from './i18n'
import { Badge, Banner, Button, Card, CopyField, Section, type BadgeTone } from './ui'

interface OpenApi {
  servers?: { url: string }[]
  paths: Record<string, Record<string, { tags?: string[]; summary?: string; operationId?: string; security?: unknown[] }>>
}
interface Endpoint { method: string; path: string; op: string; summary: string; tag: string }

const METHOD_TONE: Record<string, BadgeTone> = { get: 'info', post: 'ok', put: 'warn', delete: 'bad' }
const TAG_ORDER = ['Capture', 'Read', 'Wishlists']
const TAG_KEY: Record<string, string> = { Capture: 'capture', Read: 'read', Wishlists: 'wishlists' }

function CodeBlock({ code, label }: { code: string; label: string }) {
  const tt = useT()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = code
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-sm font-semibold">{label}</span>
        <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>{copied ? tt('controls.ui.copied') : tt('controls.ui.copy')}</Button>
      </div>
      <pre className="text-xs font-mono bg-hover border border-line rounded-xl p-3 overflow-x-auto whitespace-pre" tabIndex={0}>{code}</pre>
    </div>
  )
}

/** The concrete steps of the "Send clipboard to Wishy" shortcut (action names follow the device language) */
function ShortcutGuide({ base }: { base: string }) {
  useT()
  const url = `${base}/api/v1/capture`
  const Code = ({ children }: { children: string }) => <code className="font-mono text-[0.85em] bg-hover rounded px-1 py-0.5 break-all">{children}</code>
  const steps: { title: string; body: ReactNode }[] = [
    { title: t('apiDocs.shortcut.s1.title'), body: <>{t('apiDocs.shortcut.s1.text')} <strong>{t('apiDocs.shortcut.name')}</strong></> },
    { title: t('apiDocs.shortcut.s2.title'), body: <>{t('apiDocs.shortcut.s2.text')}</> },
    {
      title: t('apiDocs.shortcut.s3.title'),
      body: (
        <ul className="list-disc pl-5 space-y-1 mt-1">
          <li>{t('apiDocs.shortcut.s3.url')} <Code>{url}</Code></li>
          <li>{t('apiDocs.shortcut.s3.method')} <Code>POST</Code></li>
          <li>{t('apiDocs.shortcut.s3.header')} <Code>Authorization</Code> = <Code>Bearer wishy_XXXXXXXX_…</Code> {t('apiDocs.shortcut.s3.headerNote')}</li>
          <li>{t('apiDocs.shortcut.s3.bodyType')} <Code>JSON</Code></li>
          <li>{t('apiDocs.shortcut.s3.field')} <Code>text</Code> → {t('apiDocs.shortcut.s3.fieldValue')}</li>
        </ul>
      ),
    },
    { title: t('apiDocs.shortcut.s4.title'), body: <>{t('apiDocs.shortcut.s4.text')} <Code>{t('apiDocs.shortcut.s4.message')}</Code></> },
    { title: t('apiDocs.shortcut.s5.title'), body: <>{t('apiDocs.shortcut.s5.text')}</> },
  ]
  return (
    <Card className="space-y-4">
      <p className="text-sm text-muted">{t('apiDocs.shortcut.intro')}</p>
      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="grid place-items-center size-7 rounded-full bg-accent-soft text-accent font-semibold text-sm shrink-0" aria-hidden>{i + 1}</span>
            <div className="min-w-0 text-sm flex-1">
              <div className="font-semibold">{s.title}</div>
              <div className="text-muted mt-0.5 [&_strong]:text-ink [&_code]:text-ink">{s.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="meta">{t('apiDocs.shortcut.options')}</p>
      <p className="meta">{t('apiDocs.shortcut.plain')}</p>
    </Card>
  )
}

/** Public API documentation: address, authentication, endpoints (from openapi.json), curl examples, shortcut guide */
export function ApiDocs() {
  useT()
  const [doc, setDoc] = useState<OpenApi | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => { api<OpenApi>('GET', '/api/v1/openapi.json').then(setDoc).catch(() => setFailed(true)) }, [])

  const apiBase = doc?.servers?.[0]?.url ?? `${window.location.origin}/api/v1`
  const base = apiBase.replace(/\/api\/v1\/?$/, '')
  const endpoints: Endpoint[] = []
  for (const [path, ops] of Object.entries(doc?.paths ?? {})) {
    for (const [method, o] of Object.entries(ops)) endpoints.push({ method, path, op: o.operationId ?? '', summary: o.summary ?? '', tag: o.tags?.[0] ?? 'Read' })
  }
  const tags = [...new Set(endpoints.map((e) => e.tag))].sort((a, b) => (TAG_ORDER.indexOf(a) + 1 || 99) - (TAG_ORDER.indexOf(b) + 1 || 99))
  const opText = (e: Endpoint) => {
    const k = `apiDocs.op.${e.op}`
    const v = t(k as TKey)
    return v === k ? e.summary : v
  }
  const KEY = 'wishy_XXXXXXXX_…'
  const curlMe = `curl -H "Authorization: Bearer ${KEY}" \\\n  ${apiBase}/me`
  const curlCapture = `curl -X POST ${apiBase}/capture \\\n  -H "Authorization: Bearer ${KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text": "${t('apiDocs.example.text')}", "kind": "idea"}'`
  const curlPlain = `curl -X POST ${apiBase}/capture \\\n  -H "Authorization: Bearer ${KEY}" \\\n  -H "Content-Type: text/plain" \\\n  --data-binary "https://example.com/product"`
  const curlIdeas = `curl "${apiBase}/ideas?person=inbox" \\\n  -H "X-API-Key: ${KEY}"`

  return (
    <div className="space-y-8">
      <Section title={t('apiDocs.title')}>
        <Card className="space-y-4">
          <CopyField label={t('apiDocs.baseUrl')} value={apiBase} hint={t('apiDocs.baseUrlHint')} />
          <div className="text-sm space-y-1.5">
            <div className="font-semibold">{t('apiDocs.auth')}</div>
            <p className="text-muted">{t('apiDocs.authText')}</p>
            <pre className="text-xs font-mono bg-hover border border-line rounded-xl p-3 overflow-x-auto" tabIndex={0}>{`Authorization: Bearer ${KEY}\n# ${t('apiDocs.or')}\nX-API-Key: ${KEY}`}</pre>
            <p className="meta">{t('apiDocs.rateLimit')}</p>
          </div>
          <div><Button size="sm" icon={ExternalLink} href={`${base}/api/v1/openapi.json`}>{t('apiDocs.openapi')}</Button></div>
        </Card>
      </Section>

      <Section title={t('apiDocs.endpoints')}>
        {failed && <Banner tone="warn">{t('apiDocs.loadFailed')}</Banner>}
        {tags.map((tag) => (
          <div key={tag} className="space-y-2">
            <h3 className="h3">{t(`apiDocs.tag.${TAG_KEY[tag] ?? 'read'}` as TKey)}</h3>
            <div className="card divide-y divide-line overflow-hidden">
              {endpoints.filter((e) => e.tag === tag).map((e) => (
                <div key={e.method + e.path} className="px-4 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <Badge tone={METHOD_TONE[e.method] ?? 'neutral'} className="uppercase w-14 justify-center">{e.method}</Badge>
                  <code className="font-mono text-sm break-all">{e.path}</code>
                  <span className="text-sm text-muted basis-full sm:basis-auto sm:flex-1 min-w-0">{opText(e)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title={t('apiDocs.examples')}>
        <Card className="space-y-5">
          <CodeBlock label={t('apiDocs.ex.me')} code={curlMe} />
          <CodeBlock label={t('apiDocs.ex.capture')} code={curlCapture} />
          <CodeBlock label={t('apiDocs.ex.plain')} code={curlPlain} />
          <CodeBlock label={t('apiDocs.ex.inbox')} code={curlIdeas} />
        </Card>
      </Section>

      <Section title={t('apiDocs.shortcut.title')}>
        <ShortcutGuide base={base} />
      </Section>
    </div>
  )
}
