import { useState } from 'react'
import { tintOf } from './ui'

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase()

/**
 * Profile picture of an app user: loads `src` (or `/api/avatars/<userId>`), shows the initials in a tinted circle if there is no image.
 * Always square/round. Any size (px).
 */
export function UserAvatar({ userId, name, src, size = 32, className = '' }: { userId: number; name: string; src?: string | null; size?: number; className?: string }) {
  const url = src === undefined ? `/api/avatars/${userId}` : src
  const [failed, setFailed] = useState<string | null>(null)
  const show = !!url && failed !== url
  return (
    <span
      className={`relative inline-grid place-items-center rounded-full shrink-0 overflow-hidden font-display font-bold leading-none text-ink ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.36, background: tintOf(userId) }}
      title={name}
    >
      {show
        ? <img src={url!} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(url)} />
        : initials(name)}
    </span>
  )
}

/** Just the image, laid opaquely over a round, `relative`-positioned parent circle (for person avatars with a linked user). If it is missing, the parent circle stays visible. */
export function UserPictureOverlay({ userId, src }: { userId: number; src?: string | null }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return <img src={src ?? `/api/avatars/${userId}`} alt="" loading="lazy" className="absolute inset-0 size-full object-cover rounded-full" onError={() => setFailed(true)} />
}
