export type FollowType = 'phone' | 'visit' | 'wechat' | 'email' | 'note'
export type FollowEntityType = 'customer' | 'lead' | 'opportunity'

export interface FollowAttachment {
 name: string
 url: string
}

export interface Follow {
 id: string
 entityType: FollowEntityType
 entityId: string
 type: FollowType
 content: string
 nextFollowAt?: string
 attachments?: FollowAttachment[]
 createdBy: string
 createdByName?: string
 createdAt: string
}

export type FollowInput = Omit<Follow, 'id' | 'createdByName' | 'createdAt'>