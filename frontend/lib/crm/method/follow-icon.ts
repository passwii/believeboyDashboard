import type { FollowType } from '@/lib/crm/types/follow'
import {
 Phone,
 MapPin,
 MessageCircle,
 Mail,
 FileText,
 type LucideIcon,
} from 'lucide-react'

export const FOLLOW_TYPE_ICONS: Record<FollowType, LucideIcon> = {
 phone: Phone,
 visit: MapPin,
 wechat: MessageCircle,
 email: Mail,
 note: FileText,
}

export function getFollowIcon(type: FollowType): LucideIcon {
 return FOLLOW_TYPE_ICONS[type] ?? FileText
}