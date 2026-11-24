import { useT, t } from '../i18n'
import { AiBadge, useAiStatus, type AiFeatureKey } from '../ai'
import { useFeatures } from '../features'
import { OwnAiUsage } from './api-tab'
import { Badge, Card, Section } from '../ui'

const KEYS: AiFeatureKey[] = ['link_import', 'text_import', 'image_import', 'suggestions']

/** Settings › AI: where AI is used, whether it is on for you, which provider kind and what data is sent */
export function AiTab() {
  useT()
  const ai = useAiStatus()
  const f = useFeatures()
  const global = ai.global_enabled ?? ai.enabled
  const user = ai.user_enabled ?? true
  const off = !global ? t('ai.overview.offGlobal') : !user ? t('ai.overview.offUser') : null
  const linkMode = ai.link_mode === 'builtin' ? t('ai.linkMode.builtin') : t('ai.linkMode.ai')
  return (
    <>
    <Section title={t('ai.overview.title')}>
      <Card className="space-y-4">
        <p className="text-sm text-muted">{t('ai.overview.intro')}</p>
        {off && <p className="text-sm font-medium">{off}</p>}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          {global && ai.provider_label && (<><dt className="text-muted">{t('ai.overview.provider')}</dt><dd>{ai.provider_label}</dd></>)}
          <dt className="text-muted">{t('ai.overview.ownKey')}</dt><dd>{t('ai.overview.ownKeyNo')}</dd>
          <dt className="text-muted">{t('ai.overview.linkDefault')}</dt><dd>{global ? linkMode : t('ai.linkMode.builtin')}</dd>
        </dl>
        <ul className="divide-y divide-line">
          {KEYS.map((k) => {
            const on = ai.enabled && ai.features[k]
            return (
              <li key={k} className="py-3 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AiBadge />
                  <span className="font-semibold">{t(`ai.overview.${k}.name` as const)}</span>
                  <Badge tone={on ? 'ok' : 'neutral'}>{on ? t('ai.overview.status.on') : t('ai.overview.status.off')}</Badge>
                </div>
                <p className="text-sm text-muted">{t(`ai.overview.${k}.where` as const)}</p>
                <p className="meta"><span className="font-medium">{t('ai.overview.sent')}:</span> {t(`ai.sent.${k}` as const)}</p>
              </li>
            )
          })}
        </ul>
      </Card>
    </Section>
    {f.ai && <OwnAiUsage />}
    </>
  )
}
