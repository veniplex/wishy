import { Baby, BookOpen, Briefcase, Cake, CalendarDays, Camera, Car, Egg, Flower2, Gem, Ghost, Gift, GraduationCap, Heart, HeartHandshake, House, Leaf, Music, PartyPopper, Plane, Shirt, Snowflake, Sparkles, Star, Sun, TreePalm, TreePine, Trophy, Utensils, Wine, type LucideIcon } from 'lucide-react'

/**
 * Icons of occasion types by their stored name. The server validates against OCCASION_ICONS in server/occasion-types.js; this map must
 * contain exactly the same names (scripts/tests/occasion-types.mjs checks it). It is also the icon picker's list.
 */
export const OCCASION_ICON_MAP: Record<string, LucideIcon> = {
  cake: Cake, 'tree-pine': TreePine, gift: Gift, egg: Egg, heart: Heart, 'heart-handshake': HeartHandshake, gem: Gem, baby: Baby, home: House,
  flower: Flower2, 'graduation-cap': GraduationCap, briefcase: Briefcase, plane: Plane, 'party-popper': PartyPopper, star: Star, sun: Sun,
  snowflake: Snowflake, music: Music, trophy: Trophy, calendar: CalendarDays, wine: Wine, utensils: Utensils, car: Car, camera: Camera,
  'book-open': BookOpen, sparkles: Sparkles, ghost: Ghost, leaf: Leaf, shirt: Shirt, palmtree: TreePalm,
}
export const occasionIconByName = (name: string | null | undefined): LucideIcon => OCCASION_ICON_MAP[name ?? ''] ?? CalendarDays
