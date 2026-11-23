import { Monitor, Moon, Sun } from 'lucide-react'
import { LanguageSegmented } from '../i18n/switch'
import { t } from '../i18n'
import { themeModes, useTheme } from '../theme'
import { Card, Field, Section, Segmented } from '../ui'

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon }

/** Settings › Appearance: color scheme and language */
export function AppearanceTab() {
  const [mode, setMode] = useTheme()
  return (
    <>
      <Section title={t('settings.appearance.theme.title')}>
        <Card>
          <Field label={t('settings.appearance.theme.field')} group hint={t('settings.appearance.theme.hint')}>
            <Segmented label={t('settings.appearance.theme.field')} value={mode} onChange={setMode} options={themeModes().map((m) => ({ ...m, icon: THEME_ICONS[m.value] }))} />
          </Field>
        </Card>
      </Section>
      <Section title={t('settings.appearance.language.title')}>
        <Card>
          <Field label={t('settings.appearance.language.field')} group hint={t('settings.appearance.language.hint')}>
            <LanguageSegmented />
          </Field>
        </Card>
      </Section>
    </>
  )
}
